import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import {
  type GraphQLEnumType,
  type GraphQLSchema,
  printSchema,
} from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Args,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  InputType,
  Query,
  Resolver,
  registerEnumType,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

enum Category {
  BOOKS = "books",
  MOVIES = "movies",
}

registerEnumType(Category, { name: "Category" });

@InputType()
class CategoryFilterInput {
  @Field(() => Category, { defaultValue: "BOOKS" })
  category!: Category;
}

@Resolver()
class CategoryResolver {
  @Query(() => String)
  getCategory(
    @Args("category", { type: () => Category, defaultValue: "BOOKS" })
    category: Category,
  ): string {
    return category;
  }

  @Query(() => String)
  getCategoryAlreadyValue(
    @Args("category", { type: () => Category, defaultValue: Category.MOVIES })
    category: Category,
  ): string {
    return category;
  }

  @Query(() => String)
  filterCategories(
    @Args("filter", { type: () => CategoryFilterInput })
    filter: CategoryFilterInput,
  ): string {
    return filter.category;
  }
}

describeConformance(
  "Enum default value translation (issue #3618)",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/enum-default-value.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass]) to Bunest GraphQLSchemaFactory.create([new ResolverClass()]) (ADR-013).",
  },
  () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      const schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      schema = await schemaFactory.create([new CategoryResolver()]);
    });

    // BUNEST_BUG: GraphQLSchemaFactory (packages/graphql/src/schema/graphql-schema.factory.ts:1170,1221) does not translate enum key string defaultValue ("BOOKS") to the enum member value ("books"), causing printSchema(schema) to throw GraphQLError: Enum "Category" cannot represent value: "BOOKS".
    it.skip("should emit the enum key when defaultValue is passed as the enum key string", () => {
      const printed = printSchema(schema);
      expect(printed).toContain(
        "getCategory(category: Category! = BOOKS): String!",
      );
    });

    // BUNEST_BUG: printSchema(schema) throws GraphQLError: Enum "Category" cannot represent value: "BOOKS" because GraphQLSchemaFactory (packages/graphql/src/schema/graphql-schema.factory.ts:1170,1221) fails to translate the sibling enum key defaultValue ("BOOKS") on the same schema.
    it.skip("should emit the enum key when defaultValue is passed as the actual enum value", () => {
      const printed = printSchema(schema);
      expect(printed).toContain(
        "getCategoryAlreadyValue(category: Category! = MOVIES): String!",
      );
    });

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateInputType (packages/graphql/src/schema/graphql-schema.factory.ts:1170) does not translate enum key string defaultValue ("BOOKS") on @InputType() fields to the enum member value ("books"), causing printSchema(schema) to throw.
    it.skip("should translate enum key default values on input object fields", () => {
      const printed = printSchema(schema);
      expect(printed).toContain("category: Category! = BOOKS");
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildArgsConfig (packages/graphql/src/schema/graphql-schema.factory.ts:1221) stores raw enum key "BOOKS" instead of resolved enum value Category.BOOKS ("books") on GraphQLArgument.defaultValue.
    it.skip("should store the resolved enum value on the generated GraphQLEnumType", () => {
      const queryType = schema.getQueryType();
      const fields = queryType!.getFields();
      const categoryArg = fields.getCategory!.args.find(
        (a) => a.name === "category",
      );
      expect(categoryArg).toBeDefined();
      expect(categoryArg!.defaultValue).toBe(Category.BOOKS);
      const innerType =
        "ofType" in categoryArg!.type
          ? (categoryArg!.type as unknown as { ofType: GraphQLEnumType }).ofType
          : (categoryArg!.type as GraphQLEnumType);
      expect(innerType.toString()).toBe("Category");
    });
  },
);
