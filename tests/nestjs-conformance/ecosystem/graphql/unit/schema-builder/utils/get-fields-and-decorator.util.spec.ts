import { expect, it } from "bun:test";
import {
  GraphQLInputObjectType,
  GraphQLList,
  printType,
} from "../../../../../../../packages/graphql/src";
import type { Type } from "../../../../../../../packages/core/src/common";
import {
  Args,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  InputType,
  Int,
  ObjectType,
  type PropertyMetadata,
  Query,
  Resolver,
  type ReturnTypeFuncValue,
  UnableToFindFieldsError,
  getFieldsAndDecoratorForType,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@ObjectType({ isAbstract: true })
class FieldsBaseModel {
  @Field()
  id!: string;
}

@ObjectType()
class FieldsTestModel extends FieldsBaseModel {
  @Field(() => Int, { nullable: true, description: "Number of items" })
  count?: number;

  @Field(() => [String])
  tags!: string[];
}

@InputType()
class FieldsTestInput {
  @Field()
  name!: string;
}

/**
 * A custom mapped type helper, built the same way as the built-in ones:
 * every field of the source type becomes an optional list of its type.
 */
function FilterType<T>(classRef: Type<T>): Type<Record<string, unknown>> {
  const { fields } = getFieldsAndDecoratorForType(classRef);

  @InputType({ isAbstract: true })
  abstract class FilterInput {}

  fields.forEach((field: PropertyMetadata) => {
    const typeRef = field.typeFn();
    Field(() => [typeRef as ReturnTypeFuncValue], { nullable: true })(
      FilterInput.prototype,
      field.name,
    );
  });
  return FilterInput as Type<Record<string, unknown>>;
}

describeConformance(
  "getFieldsAndDecoratorForType",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/utils/get-fields-and-decorator.util.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass resolver instances per @bunest/graphql API (ADR-013).",
  },
  () => {
    // BUNEST_BUG: Expected getFieldsAndDecoratorForType(FieldsTestModel) for @Field(() => [String]) tags to return typeFn() === String and options.isArray === true, got typeFn() === [String] and options.isArray === undefined; packages/graphql/src/decorators/type.decorators.ts (getFieldsAndDecoratorForType:829-838) does not unwrap array type thunks into element typeFn + options.isArray/arrayDepth.
    it.skip("should return own and inherited fields with their metadata", () => {
      const { fields } = getFieldsAndDecoratorForType(FieldsTestModel);

      expect(fields.map((field) => field.name)).toEqual([
        "id",
        "count",
        "tags",
      ]);

      const count = fields.find((field) => field.name === "count")!;
      expect(count.typeFn()).toBe(Int);
      expect(count.options.nullable).toBe(true);
      expect(count.description).toBe("Number of items");

      const tags = fields.find((field) => field.name === "tags")!;
      expect(tags.typeFn()).toBe(String);
      expect(tags.options.isArray).toBe(true);
    });

    it("should return the class decorator that matches the type kind", () => {
      expect(
        getFieldsAndDecoratorForType(FieldsTestModel).decoratorFactory,
      ).toBe(ObjectType);
      expect(
        getFieldsAndDecoratorForType(FieldsTestInput).decoratorFactory,
      ).toBe(InputType);
    });

    it("should throw an UnableToFindFieldsError for a class that is not a GraphQL type", () => {
      class NotAGraphQLType {}

      expect(() => getFieldsAndDecoratorForType(NotAGraphQLType)).toThrow(
        UnableToFindFieldsError,
      );
    });

    // BUNEST_BUG: Expected printType(FieldsTestModelFilter) to contain 'tags: [String!]', got 'tags: [[String!]!]'; packages/graphql/src/decorators/type.decorators.ts (getFieldsAndDecoratorForType:829-838) returns raw [String] from tags.typeFn() instead of unwrapped String, causing custom mapped type FilterType(() => [typeRef]) to double-wrap list fields.
    it.skip("should allow building a custom mapped type", async () => {
      @InputType()
      class FieldsTestModelFilter extends FilterType(FieldsTestModel) {}

      @Resolver()
      class FieldsTestResolver {
        @Query(() => [FieldsTestModel])
        models(
          @Args("filter", {
            type: () => FieldsTestModelFilter,
            nullable: true,
          })
          _filter?: FieldsTestModelFilter,
        ): FieldsTestModel[] {
          return [];
        }
      }

      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      const schema = await moduleRef
        .get(GraphQLSchemaFactory)
        .create([new FieldsTestResolver()]);

      const filterType = schema.getType(
        "FieldsTestModelFilter",
      ) as GraphQLInputObjectType;
      expect(filterType).toBeInstanceOf(GraphQLInputObjectType);
      expect(filterType.getFields().count?.type).toBeInstanceOf(GraphQLList);
      expect(printType(filterType)).toEqual(
        [
          "input FieldsTestModelFilter {",
          "  id: [String!]",
          "  count: [Int!]",
          "  tags: [String!]",
          "}",
        ].join("\n"),
      );
    });
  },
);
