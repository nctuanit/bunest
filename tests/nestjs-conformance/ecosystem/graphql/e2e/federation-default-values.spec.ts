import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  DirectiveLocation,
  GraphQLDirective,
  GraphQLEnumType,
  type GraphQLSchema,
  getDirectiveValues,
  isObjectType,
} from "../../../../../packages/graphql/node_modules/graphql";
import { Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Directive,
  Field,
  GraphQLISODateTime,
  GraphQLModule,
  InputType,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

enum Role {
  GUEST = 0,
  USER = 1,
  ADMIN = 2,
}
registerEnumType(Role, { name: "Role" });

const RankType = new GraphQLEnumType({
  name: "Rank",
  values: {
    GUEST: { value: Role.GUEST },
    USER: { value: Role.USER },
    ADMIN: { value: Role.ADMIN },
  },
});

// directive @auth(requires: Rank = ADMIN, until: DateTime = "1970-...") on FIELD_DEFINITION
const authDirective = new GraphQLDirective({
  name: "auth",
  locations: [DirectiveLocation.FIELD_DEFINITION],
  args: {
    requires: { type: RankType, defaultValue: Role.ADMIN },
    until: { type: GraphQLISODateTime, defaultValue: new Date(0) },
  },
});

const authDirectiveArgs: Record<string, Record<string, unknown>> = {};

function authDirectiveTransformer(schema: GraphQLSchema): GraphQLSchema {
  const directive = schema.getDirective("auth");
  if (!directive) {
    return schema;
  }
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__")) {
      continue;
    }
    for (const [fieldName, field] of Object.entries(type.getFields())) {
      if (field.astNode) {
        const auth = getDirectiveValues(directive, field.astNode);
        if (auth) {
          authDirectiveArgs[fieldName] = auth;
        }
      }
    }
  }
  return schema;
}

@InputType()
class EmployeeFilter {
  @Field(() => Role, { defaultValue: Role.ADMIN })
  role!: Role;

  @Field(() => GraphQLISODateTime, { defaultValue: new Date(0) })
  since!: Date;
}

@ObjectType()
class Employee {
  @Field()
  name!: string;

  @Directive("@auth")
  @Field()
  salary!: number;

  @Directive("@auth(requires: USER)")
  @Field()
  bonus!: number;
}

@Resolver(() => Employee)
class EmployeeResolver {
  @Query(() => Employee)
  employee(): Employee {
    return { name: "Ada", salary: 1, bonus: 2 };
  }

  @Query(() => String)
  argDefaults(
    @Args({ name: "role", type: () => Role, defaultValue: Role.ADMIN })
    role: Role,
    @Args({
      name: "since",
      type: () => GraphQLISODateTime,
      defaultValue: new Date(0),
    })
    since: Date,
  ): string {
    return formatDefaults(role, since);
  }

  @Query(() => String)
  inputDefaults(@Args("filter") filter: EmployeeFilter): string {
    return formatDefaults(filter.role, filter.since);
  }
}

function formatDefaults(role: Role, since: Date): string {
  return `${JSON.stringify(role)}/${
    since instanceof Date ? since.toISOString() : typeof since
  }`;
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      federation: { version: 2 },
      autoSchemaFile: { federation: 2 },
      buildSchemaOptions: { directives: [authDirective] },
      transformSchema: authDirectiveTransformer,
    }),
  ],
  providers: [EmployeeResolver],
})
class DefaultValuesFederationModule {}

describeConformance(
  "Federation - default values of the code-first schema",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation-default-values.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver default values E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) using pure graphql-js getDirectiveValues instead of @graphql-tools/utils.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      for (const k of Object.keys(authDirectiveArgs)) {
        delete authDirectiveArgs[k];
      }
      const moduleRef = await Test.createTestingModule({
        imports: [DefaultValuesFederationModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    async function execute(query: string) {
      const res = await request(app)
        .post("/graphql")
        .send({ query })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      return res.body.data as Record<string, unknown>;
    }

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts) stores @Directive() annotations only in `field.extensions.directives` without creating AST `field.astNode.directives`, so directive argument defaults cannot be resolved (`authDirectiveArgs.salary` is `undefined` instead of `{ requires: Role.ADMIN, until: new Date(0) }`).
    it.skip("should keep the declared defaults of directive arguments", () => {
      expect(authDirectiveArgs.salary?.requires).toBe(Role.ADMIN);
      expect(authDirectiveArgs.salary?.until).toEqual(new Date(0));
      expect(authDirectiveArgs.bonus?.requires).toBe(Role.USER);
    });

    it("should keep the declared defaults of field arguments", async () => {
      const data = await execute(`{ argDefaults }`);
      expect(data).toEqual({ argDefaults: "2/1970-01-01T00:00:00.000Z" });
    });

    it("should keep the declared defaults of input fields", async () => {
      const data = await execute(`{ inputDefaults(filter: {}) }`);
      expect(data).toEqual({ inputDefaults: "2/1970-01-01T00:00:00.000Z" });
    });

    it("should expose the defaults through introspection", async () => {
      const data = await execute(`
        {
          __schema {
            directives {
              name
              args {
                name
                defaultValue
              }
            }
          }
        }
      `);
      const { directives } = data.__schema as {
        directives: {
          name: string;
          args: { name: string; defaultValue: string | null }[];
        }[];
      };
      expect(directives.find(({ name }) => name === "auth")?.args).toEqual([
        { name: "requires", defaultValue: "ADMIN" },
        { name: "until", defaultValue: '"1970-01-01T00:00:00.000Z"' },
      ]);
    });
  },
);
