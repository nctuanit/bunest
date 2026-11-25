import { beforeAll, expect, it } from "bun:test";
import {
  GraphQLNonNull,
  type GraphQLObjectType,
  type GraphQLSchema,
  printSchema,
} from "../../../../../../../packages/graphql/src";
import {
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ObjectType,
  Query,
  Resolver,
  type ReturnTypeFuncValue,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@ObjectType("Author")
class AuthorModel {
  @Field(() => String)
  id!: string;
}

@Resolver()
class AuthorResolver {
  @Query(() => "Author" as unknown as ReturnTypeFuncValue)
  author(): AuthorModel {
    return { id: "author-1" };
  }
}

describeConformance(
  "Output type resolution by GraphQL name",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/output-type-by-name.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass resolver instances per @bunest/graphql API (ADR-013).",
  },
  () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      const schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      schema = await schemaFactory.create([new AuthorResolver()]);
    });

    it("builds the schema when a resolver returns an output type by GraphQL name", () => {
      expect(printSchema(schema)).toContain("author: Author!");
    });

    it("resolves the query field to the named output type", () => {
      const queryType = schema.getQueryType();
      const authorField = queryType?.getFields().author;

      expect(authorField).toBeDefined();
      expect(authorField!.type).toBeInstanceOf(GraphQLNonNull);
      expect(
        (authorField!.type as GraphQLNonNull<GraphQLObjectType>).ofType,
      ).toBe(schema.getType("Author") as GraphQLObjectType);
    });
  },
);
