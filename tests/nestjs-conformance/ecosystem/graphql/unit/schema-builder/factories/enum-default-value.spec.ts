import { beforeAll, expect, it } from "bun:test";
import {
  type GraphQLEnumType,
  type GraphQLSchema,
  printSchema,
} from "../../../../../../../packages/graphql/src";
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

    it("should emit the enum key when defaultValue is passed as the enum key string", () => {
      const printed = printSchema(schema);
      expect(printed).toContain(
        "getCategory(category: Category! = BOOKS): String!",
      );
    });

    it("should emit the enum key when defaultValue is passed as the actual enum value", () => {
      const printed = printSchema(schema);
      expect(printed).toContain(
        "getCategoryAlreadyValue(category: Category! = MOVIES): String!",
      );
    });

    it("should translate enum key default values on input object fields", () => {
      const printed = printSchema(schema);
      expect(printed).toContain("category: Category! = BOOKS");
    });

    it("should store the resolved enum value on the generated GraphQLEnumType", () => {
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
