import { afterAll, beforeAll, expect, it } from "bun:test";
import type { GraphQLObjectType } from "../../../../../packages/graphql/src";
import { Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GraphQLModule,
  GraphQLSchemaHost,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  type ResolveFieldOptions,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

const ResolveFieldOptionsOnly = ResolveField as unknown as (
  options: ResolveFieldOptions,
) => MethodDecorator;

@ObjectType()
class Author {
  @Field()
  id!: string;
}

@Resolver(() => Author)
class AuthorResolver {
  @Query(() => Author)
  author(): Author {
    return { id: "1" };
  }

  /**
   * Options-object-only form: the schema field is named after `name`, while the
   * method keeps a different name. Both the schema field and the resolver map
   * entry have to end up as "displayName".
   */
  @ResolveFieldOptionsOnly({ name: "displayName" })
  resolveDisplayName(@Parent() author: Author): string {
    return `author-${author.id}`;
  }
}

@Module({
  providers: [AuthorResolver],
})
class AuthorModule {}

@Module({
  imports: [
    GraphQLModule.forRoot({
      autoSchemaFile: true,
      graphiql: false,
    }),
    AuthorModule,
  ],
})
class AppModule {}

describeConformance(
  "ResolveField with a name given through options",
  {
    upstreamPath: "packages/apollo/tests/e2e/resolve-field-name.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts @nestjs/apollo resolve-field-name E2E to native @bunest/graphql and zero-socket Bun HTTP requests.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it("exposes the field under the configured name", () => {
      const { schema } = app.get(GraphQLSchemaHost);
      const authorType = schema.getType("Author") as GraphQLObjectType;
      const fields = authorType.getFields();

      expect(fields.displayName).toBeTruthy();
      expect(fields.resolveDisplayName).toBeUndefined();
    });

    it("resolves the field through the decorated method", async () => {
      const response = await request(app)
        .post("/graphql")
        .send({ query: "{ author { id displayName } }" })
        .expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.author).toEqual({
        id: "1",
        displayName: "author-1",
      });
    });
  },
);
