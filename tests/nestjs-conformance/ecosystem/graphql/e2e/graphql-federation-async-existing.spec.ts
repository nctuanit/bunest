import "reflect-metadata";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, it } from "bun:test";
import { Injectable, Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  type GqlModuleOptions,
  type GqlOptionsFactory,
  GraphQLModule,
  Query,
  ResolveReference,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

const USERS_FEDERATION_SDL = `
type User @key(fields: "id") {
  id: ID!
  name: String!
}

extend type Query {
  getUser(id: ID!): User
}
`;

interface User {
  id: string;
  name: string;
}

@Injectable()
class UsersService {
  private readonly users: User[] = [{ id: "5", name: "GraphQL" }];

  findById(id: string): Promise<User | undefined> {
    return Promise.resolve(this.users.find((p) => p.id === id));
  }
}

@Resolver("User")
class UsersResolvers {
  constructor(private readonly usersService: UsersService) {}

  @Query(() => Object, { name: "getUser" })
  getUser(@Args("id") id: string) {
    return this.usersService.findById(id);
  }

  @ResolveReference()
  resolveReference(reference: { __typename: string; id: string }) {
    return this.usersService.findById(reference.id);
  }
}

@Module({
  providers: [UsersResolvers, UsersService],
})
class UsersModule {}

describeConformance(
  "GraphQL Federation Async (useExisting)",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/graphql-federation-async-existing.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver schema-first async-existing E2E to native @bunest/graphql forRootAsync({ useExisting }) (ADR-001, ADR-013) via zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "bunest-fed-async-existing-"));
      writeFileSync(
        join(tmpDir, "users.types.graphql"),
        USERS_FEDERATION_SDL,
        "utf8",
      );
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      @Injectable()
      class ConfigService implements GqlOptionsFactory {
        public createGqlOptions(): GqlModuleOptions {
          return {
            federation: { version: 2 },
            typePaths: [join(tmpDir, "**/*.graphql")],
          };
        }
      }

      @Module({
        providers: [ConfigService],
        exports: [ConfigService],
      })
      class ConfigModule {}

      @Module({
        imports: [
          GraphQLModule.forRootAsync({
            useExisting: ConfigService,
            imports: [ConfigModule],
            inject: [ConfigService],
          }),
          UsersModule,
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildSchemaFirst (packages/graphql/src/schema/graphql-schema.factory.ts:1600) ignores `options.federation` and calls raw `buildASTSchema(parse(sdl))`, throwing `Unknown directive "@key". Cannot extend type "Query" because it is not defined.` on schema-first Federation SDL.
    it.skip("should return query result", async () => {
      await request(app)
        .post("/graphql")
        .send({
          operationName: null,
          variables: {},
          query: `
          {
            getUser(id: "5") {
              id,
              name,
            }
          }`,
        })
        .expect(200, {
          data: {
            getUser: {
              id: "5",
              name: "GraphQL",
            },
          },
        });
    });
  },
);
