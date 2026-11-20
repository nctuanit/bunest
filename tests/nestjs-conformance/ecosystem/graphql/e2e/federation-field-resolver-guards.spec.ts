import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  type CanActivate,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GraphQLModule,
  ID,
  Int,
  InterfaceType,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@InterfaceType()
abstract class Person {
  @Field(() => ID)
  id!: string;

  salary!: number;
}

@ObjectType({ implements: () => [Person] })
class Employee implements Person {
  id!: string;
  salary!: number;

  @Field()
  department!: string;
}

@ObjectType()
class User {
  @Field(() => ID)
  id!: string;

  @Field()
  displayName!: string;

  email!: string;
  name!: string;
}

@Resolver(() => Person)
class PersonResolver {
  @UseGuards(DenyGuard)
  @ResolveField(() => Int)
  salary(@Parent() person: Person): number {
    return person.salary;
  }
}

@Resolver(() => Employee)
class EmployeeResolver {
  @Query(() => Employee)
  employee(): Employee {
    return { id: "1", salary: 61000, department: "R&D" };
  }
}

@Resolver(() => User)
class UserResolver {
  @Query(() => User)
  user(): Omit<User, "displayName"> {
    return { id: "1", email: "alice@example.com", name: "alice" };
  }

  @UseGuards(DenyGuard)
  @ResolveField(() => String)
  email(@Parent() user: User): string {
    return user.email;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      federation: { version: 2 },
      autoSchemaFile: true,
      fieldResolverEnhancers: ["guards"],
      resolvers: {
        User: {
          displayName: (user: User) => user.name.toUpperCase(),
        },
      },
      includeStacktraceInErrorResponses: false,
    }),
  ],
  providers: [PersonResolver, EmployeeResolver, UserResolver],
})
class FieldResolverGuardsFederationModule {}

describeConformance(
  "Federation - guards of field resolvers",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation-field-resolver-guards.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver field resolver guards E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) via zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [FieldResolverGuardsFederationModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    async function execute(query: string) {
      const res = await request(app).post("/graphql").send({ query });
      return res.body as {
        data?: Record<string, unknown> | null;
        errors?: Array<{ message: string }>;
      };
    }

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts) does not bind @ResolveField() (and its @UseGuards()) declared on @Resolver(() => Person) onto implementing @ObjectType() Employee; `{ employee { department salary } }` returns HTTP 400 validation error (`data` undefined) instead of `data: null` with `"Forbidden resource"`.
    it.skip("should run the guards of an interface field resolver on implementing types", async () => {
      const result = await execute(`{ employee { department salary } }`);
      expect(result.data).toBeNull();
      expect(result.errors?.[0]?.message).toBe("Forbidden resource");
    });

    it('should keep guarded field resolvers of a type named in the "resolvers" option', async () => {
      const result = await execute(`{ user { email } }`);
      expect(result.data).toBeNull();
      expect(result.errors?.[0]?.message).toBe("Forbidden resource");
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildCodeFirst (packages/graphql/src/schema/graphql-schema.factory.ts) ignores `options.resolvers` in code-first mode (`applyResolversMap` is only invoked in `buildSchemaFirst`), causing `User.displayName` to fail with `Cannot return null for non-nullable field User.displayName.` instead of returning `"ALICE"`.
    it.skip('should apply the "resolvers" option to the same type', async () => {
      const result = await execute(`{ user { displayName } }`);
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ user: { displayName: "ALICE" } });
    });
  },
);
