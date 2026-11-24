import { afterAll, beforeAll, expect, it } from "bun:test";
import { Module } from "../../../../../packages/core/src/common";
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
  secret() {
    return "******";
  }

  @ResolveField(() => String)
  masked() {
    return "******";
  }
}

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
      autoSchemaFile: true,
      transformResolvers: dropSecretResolver,
    }),
  ],
  providers: [ProfileResolver],
})
class UnboundFieldResolverModule {}

describeConformance(
  "code-first field declared by a field resolver that is not bound",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/code-first-unbound-field-resolver.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo unbound field resolver safety E2E to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [UnboundFieldResolverModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it("should refuse to resolve the field instead of reading the parent property", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({ query: "{ profile { id secret } }" })
        .expect(200);
      const { data, errors } = res.body as {
        data: unknown;
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
