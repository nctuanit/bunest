import "reflect-metadata";
import { afterAll, beforeAll, expect, it, spyOn } from "bun:test";
import { Logger, Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GraphQLModule,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  type SchemaFirstResolversMap,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@ObjectType()
class Profile {
  @Field()
  id!: string;

  @Field()
  nickname!: string;
}

const profile = {
  id: "1",
  nickname: "ada",
  secret: "s3cr3t",
  masked: "s3cr3t",
};

@Resolver(() => Profile)
class ProfileResolver {
  @Query(() => Profile)
  profile() {
    return profile;
  }

  // Declared only by a field resolver: "Profile" has no "@Field() secret".
  @ResolveField(() => String)
  secret(): string {
    return "******";
  }

  @ResolveField(() => String)
  masked(): string {
    return "******";
  }
}

/**
 * Drops the "Profile.secret" field resolver from the discovered resolvers.
 */
function dropSecretResolver(
  resolvers: SchemaFirstResolversMap | SchemaFirstResolversMap[],
): SchemaFirstResolversMap[] {
  return ([] as SchemaFirstResolversMap[])
    .concat(resolvers)
    .map((typeResolvers) => {
      if (!typeResolvers.Profile) {
        return typeResolvers;
      }
      const { secret: _secret, ...profileResolvers } = typeResolvers.Profile;
      return { ...typeResolvers, Profile: profileResolvers };
    });
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      federation: { version: 2 },
      autoSchemaFile: true,
      transformResolvers: dropSecretResolver,
      includeStacktraceInErrorResponses: false,
    }),
  ],
  providers: [ProfileResolver],
})
class UnboundFieldResolverFederationModule {}

describeConformance(
  "Federation - code-first field declared by a field resolver that is not bound",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation-unbound-field-resolver.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver unbound field resolver E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) via zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;
    const warnings: string[] = [];

    beforeAll(async () => {
      const warn = spyOn(Logger.prototype, "warn").mockImplementation(
        (message: unknown) => {
          warnings.push(String(message));
        },
      );
      try {
        const moduleRef = await Test.createTestingModule({
          imports: [UnboundFieldResolverFederationModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      } finally {
        warn.mockRestore();
      }
    });

    afterAll(async () => {
      await app.close();
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildCodeFirst (packages/graphql/src/schema/graphql-schema.factory.ts) ignores `options.transformResolvers` in code-first mode and does not warn about unbound @ResolveField() fields (`warnings` is `[]`).
    it.skip("should warn at startup about the field", () => {
      expect(warnings).toContainEqual(
        expect.stringContaining(
          'No resolver is bound for these fields, which are declared only by a field resolver (@ResolveField()): "Profile.secret".',
        ),
      );
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildCodeFirst (packages/graphql/src/schema/graphql-schema.factory.ts) ignores `options.transformResolvers` in code-first mode, so `Profile.secret` stays bound and returns `{ profile: { id: "1", secret: "******" } }` instead of refusing with `'No resolver is bound for field "Profile.secret".'`.
    it.skip("should refuse to resolve the field instead of reading the parent property", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({ query: "{ profile { id secret } }" });
      const { data, errors } = res.body as {
        data?: Record<string, unknown> | null;
        errors?: Array<{ message: string }>;
      };
      expect(data).toBeNull();
      expect(errors?.map((error) => error.message)).toEqual([
        'No resolver is bound for field "Profile.secret".',
      ]);
    });

    it("should still resolve the other fields", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({ query: "{ profile { id nickname masked } }" })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        profile: { id: "1", nickname: "ada", masked: "******" },
      });
    });
  },
);
