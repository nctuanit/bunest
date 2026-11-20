import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import { Global, Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GraphQLModule,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers/index";

@Resolver()
class AuditResolver {
  @Query(() => String)
  lastAuditEntry(): string {
    return "internal";
  }
}

@Global()
@Module({ providers: [AuditResolver] })
class AuditModule {}

@Resolver()
class CatalogResolver {
  @Query(() => String)
  lastProduct(): string {
    return "public";
  }
}

@Module({ providers: [CatalogResolver] })
class CatalogModule {}

describeConformance(
  'GraphQL - "include" and global modules',
  {
    upstreamPath: "packages/apollo/tests/e2e/include-global-modules.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Replaces ApolloDriver with native @bunest/graphql GraphQLModule.forRoot() and zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;

    const createApp = async (include: Function[]) => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          AuditModule,
          CatalogModule,
          GraphQLModule.forRoot({
            autoSchemaFile: true,
            include,
          }),
        ],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    };

    const query = (q: string) =>
      request(app).post("/graphql").send({ query: q });

    afterEach(async () => {
      if (app) {
        await app.close();
      }
    });

    it("should not expose the resolvers of a global module that is not included", async () => {
      await createApp([CatalogModule]);

      expect((await query("{ lastProduct }")).body).toEqual({
        data: { lastProduct: "public" },
      });
      const { body } = await query("{ lastAuditEntry }");
      expect(body.data).toBeUndefined();
      expect(body.errors[0].message).toBe(
        'Cannot query field "lastAuditEntry" on type "Query".',
      );
    });

    it("should expose the resolvers of a global module that is included", async () => {
      await createApp([CatalogModule, AuditModule]);

      expect((await query("{ lastAuditEntry }")).body).toEqual({
        data: { lastAuditEntry: "internal" },
      });
    });
  },
);
