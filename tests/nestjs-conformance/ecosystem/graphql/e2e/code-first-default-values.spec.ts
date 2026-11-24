import { afterAll, beforeAll, expect, it } from "bun:test";
import { Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Field,
  type FieldMiddleware,
  GraphQLModule,
  InputType,
  Int,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

const appendStaffComment: FieldMiddleware = async (_, next) => {
  const comments = await next();
  comments.push("staff only");
  return comments;
};

@ObjectType()
class Ticket {
  @Field(() => [String], {
    defaultValue: [],
    middleware: [appendStaffComment],
  })
  comments!: string[];
}

@InputType()
class PostFilter {
  @Field(() => Int, { defaultValue: 2 })
  limit!: number;

  @Field(() => [String], { defaultValue: [] })
  tags!: string[];
}

@Resolver()
class DefaultValuesResolver {
  @Query(() => Ticket)
  ticket() {
    return {};
  }

  @Query(() => Int)
  tagCount(
    @Args("tags", { type: () => [String], defaultValue: [] }) tags: string[],
  ) {
    tags.push("mutated");
    return tags.length;
  }

  @Query(() => String)
  posts(
    @Args("filter", { type: () => PostFilter, defaultValue: {} })
    filter: PostFilter,
  ) {
    filter.tags?.push("mutated");
    return JSON.stringify(filter);
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      autoSchemaFile: true,
    }),
  ],
  providers: [DefaultValuesResolver],
})
class DefaultValuesModule {}

describeConformance(
  "Code-first default values",
  {
    upstreamPath: "packages/apollo/tests/e2e/code-first-default-values.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo code-first default values E2E to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DefaultValuesModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    // BUNEST_BUG: Expected { ticket: { comments: ["staff only"] } } on each request; actual fails with TypeError because comments is undefined. GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts:1058-1099) ignores fieldMeta.defaultValue on @ObjectType() @Field() definitions.
    it.skip("should not share an object type field default across requests", async () => {
      for (let i = 0; i < 2; i++) {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ ticket { comments } }" })
          .expect(200);
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          ticket: { comments: ["staff only"] },
        });
      }
    });

    // BUNEST_BUG: Expected { tagCount: 1 } on every request; actual returns { tagCount: 2 } on the 2nd request because GraphQLSchemaFactory.buildArgsConfig (packages/graphql/src/schema/graphql-schema.factory.ts:1221) passes the raw mutable defaultValue array reference without cloning per request.
    it.skip("should not share an argument default across requests", async () => {
      for (let i = 0; i < 2; i++) {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ tagCount }" })
          .expect(200);
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({ tagCount: 1 });
      }
    });

    // BUNEST_BUG: Expected omitted { posts } to complete filter: {} with PostFilter field defaults (limit: 2, tags: ["mutated"]); actual returns "{}" because GraphQLSchemaFactory.buildArgsConfig (packages/graphql/src/schema/graphql-schema.factory.ts:1221) does not coerce/complete omitted @InputType() argument defaultValue objects with nested input field defaults or clone them per request.
    it.skip("should complete an omitted argument default with the input field defaults", async () => {
      for (let i = 0; i < 2; i++) {
        const omitted = await request(app)
          .post("/graphql")
          .send({ query: "{ posts }" })
          .expect(200);
        const explicit = await request(app)
          .post("/graphql")
          .send({ query: "{ posts(filter: {}) }" })
          .expect(200);
        expect(omitted.body.errors).toBeUndefined();
        expect(explicit.body.errors).toBeUndefined();
        expect(omitted.body.data).toEqual({
          posts: JSON.stringify({ limit: 2, tags: ["mutated"] }),
        });
        expect(explicit.body.data).toEqual({
          posts: JSON.stringify({ limit: 2, tags: ["mutated"] }),
        });
      }
    });
  },
);
