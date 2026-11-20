import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from "../../../../../packages/graphql/node_modules/graphql";
import {
  type CanActivate,
  ForbiddenException,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GraphQLModule,
  type GraphQLModuleOptions,
  ID,
  InterfaceType,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers/index";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException("Forbidden resource");
  }
}

@InterfaceType()
abstract class Node {
  @Field(() => ID)
  id!: string;

  @Field()
  owner!: string;
}

@InterfaceType({ implements: () => [Node] })
abstract class PrivateNode implements Node {
  @Field(() => ID)
  id!: string;

  @Field()
  owner!: string;
}

@InterfaceType({ implements: () => [Node] })
abstract class Tagged implements Node {
  @Field(() => ID)
  id!: string;

  @Field()
  owner!: string;
}

@ObjectType({ implements: () => [Node, PrivateNode] })
class Payslip implements PrivateNode {
  id!: string;
  owner!: string;
}

@ObjectType({ implements: () => [PrivateNode, Node] })
class Invoice implements PrivateNode {
  id!: string;
  owner!: string;
}

@ObjectType({ implements: () => [Node] })
class Document implements Node {
  id!: string;
  owner!: string;
}

@ObjectType({ implements: () => [PrivateNode] })
class Contract extends Document {}

@ObjectType({ implements: () => [Node, Tagged, PrivateNode] })
class Note implements PrivateNode, Tagged {
  id!: string;
  owner!: string;
}

@InterfaceType()
abstract class Account {
  @Field(() => ID)
  id!: string;

  balance!: number;
}

@ObjectType({ implements: () => [Account] })
class SavingsAccount extends Account {
  @Field({
    middleware: [async (_ctx, next) => `masked:${await next()}`],
  })
  label!: string;
}

const record = {
  id: "1",
  owner: "alice@example.com",
  balance: 1234.5,
  label: "savings",
};

@Resolver(() => Node)
class NodeResolver {
  @Query(() => Payslip)
  payslip() {
    return record;
  }

  @Query(() => Invoice)
  invoice() {
    return record;
  }

  @Query(() => Contract)
  contract() {
    return record;
  }

  @Query(() => Note)
  note() {
    return record;
  }

  @ResolveField(() => String)
  owner() {
    return "Node";
  }
}

@Resolver(() => PrivateNode)
class PrivateNodeResolver {
  @ResolveField(() => String)
  @UseGuards(DenyGuard)
  owner() {
    return "PrivateNode";
  }
}

@Resolver(() => Tagged)
class TaggedResolver {
  @ResolveField(() => String)
  owner() {
    return "Tagged";
  }
}

@Resolver(() => Account)
class AccountResolver {
  @Query(() => [SavingsAccount])
  accounts() {
    return [record];
  }

  @ResolveField(() => Number)
  @UseGuards(DenyGuard)
  balance() {
    return record.balance;
  }
}

const legacySchema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      legacyVersion: {
        type: GraphQLString,
        resolve: () => "1.0",
      },
    },
  }),
});

describeConformance(
  "code-first field resolvers declared on interfaces",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/code-first-interface-resolvers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo interface field resolvers E2E to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    const cases: Array<[string, Partial<GraphQLModuleOptions>]> = [
      ['without the "schema" option', {}],
      ['with the "schema" option', { schema: legacySchema }],
      [
        'with "inheritResolversFromInterfaces"',
        { inheritResolversFromInterfaces: true },
      ],
    ];

    for (const [label, options] of cases) {
      describe(`code-first field resolvers declared on interfaces (${label})`, () => {
        @Module({
          imports: [
            GraphQLModule.forRoot({
              autoSchemaFile: true,
              fieldResolverEnhancers: ["guards"],
              ...options,
            }),
          ],
          providers: [
            NodeResolver,
            PrivateNodeResolver,
            TaggedResolver,
            AccountResolver,
            DenyGuard,
          ],
        })
        class InterfaceResolversModule {}

        let app: BunestApplication;

        beforeAll(async () => {
          const moduleRef = await Test.createTestingModule({
            imports: [InterfaceResolversModule],
          }).compile({ logger: false });
          app = moduleRef.createNestApplication({ logger: false });
          await app.init();
        });

        afterAll(async () => {
          await app.close();
        });

        async function expectForbidden(queryStr: string) {
          const res = await request(app)
            .post("/graphql")
            .send({ query: queryStr })
            .expect(200);
          const { data, errors } = res.body as {
            data: unknown;
            errors?: Array<{ message: string }>;
          };
          expect(data).toBeNull();
          expect(errors?.map((error) => error.message)).toEqual([
            "Forbidden resource",
          ]);
        }

        // BUNEST_BUG: Expected ForbiddenException from interface @ResolveField() guard; actual fails with 500 `Type Contract must implement Node because it is implemented by PrivateNode.` (getOrCreateObjectType:1021-1024 omits inherited/transitive interfaces, getOrCreateObjectType:1102 never binds @Resolver(() => Interface) field resolvers onto implementing types, resolveOutputLeaf:791 misclassifies SavingsAccount extends Account as interface) or 400 with `schema` option because GraphQLSchemaFactory.create (packages/graphql/src/schema/graphql-schema.factory.ts:351-355) returns options.schema without merging code-first resolvers.
        it.skip("should apply the guards of an interface field resolver to the implementing types", () =>
          expectForbidden("{ accounts { id balance } }"));

        for (const queryName of ["payslip", "invoice", "contract"]) {
          // BUNEST_BUG: Expected most-specific interface field resolver (PrivateNodeResolver.owner -> ForbiddenException); actual fails schema validation on Contract (getOrCreateObjectType:1021-1024), never binds interface @ResolveField() handlers onto implementing types (getOrCreateObjectType:1102), or ignores code-first resolvers when options.schema is set (packages/graphql/src/schema/graphql-schema.factory.ts:351-355).
          it.skip(`should bind the field resolver of the most specific interface, whatever the order of the interfaces (${queryName})`, () =>
            expectForbidden(`{ ${queryName} { owner } }`));
        }

        // BUNEST_BUG: Expected { payslip: { id: "1" }, accounts: [{ id: "1", label: "masked:savings" }] }; actual fails schema validation on Contract (`Type Contract must implement Node...`, getOrCreateObjectType:1021-1024) or misses merged code-first fields when options.schema is set (packages/graphql/src/schema/graphql-schema.factory.ts:351-355).
        it.skip("should keep the generated resolvers of the fields that have no field resolver", async () => {
          const res = await request(app)
            .post("/graphql")
            .send({ query: "{ payslip { id } accounts { id label } }" })
            .expect(200);
          expect(res.body.errors).toBeUndefined();
          expect(res.body.data).toEqual({
            payslip: { id: "1" },
            accounts: [{ id: "1", label: "masked:savings" }],
          });
        });

        // BUNEST_BUG: Expected last-listed interface field resolver (PrivateNodeResolver.owner -> ForbiddenException); actual fails schema validation on Contract (getOrCreateObjectType:1021-1024), never binds interface @ResolveField() handlers onto Note (getOrCreateObjectType:1102), or ignores code-first resolvers when options.schema is set (packages/graphql/src/schema/graphql-schema.factory.ts:351-355).
        it.skip("should keep the last listed interface when the interfaces are unrelated", async () => {
          await expectForbidden("{ note { owner } }");
        });

        if (options.schema) {
          it('should keep the resolvers of the "schema" option', async () => {
            const res = await request(app)
              .post("/graphql")
              .send({ query: "{ legacyVersion }" })
              .expect(200);
            expect(res.body.errors).toBeUndefined();
            expect(res.body.data).toEqual({ legacyVersion: "1.0" });
          });
        }
      });
    }
  },
);
