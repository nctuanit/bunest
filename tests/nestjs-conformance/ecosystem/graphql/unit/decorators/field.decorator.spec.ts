import "reflect-metadata";
import { afterAll, expect, it } from "bun:test";
import {
  GraphQLNonNull,
  type GraphQLObjectType,
  graphql,
} from "../../../../../../packages/graphql/node_modules/graphql";
import {
  Field,
  type FieldMiddleware,
  type FieldOptions,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ObjectType,
  Query,
  Resolver,
  type ReturnTypeFunc,
  TypeMetadataStorage,
} from "../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../_helpers/index";

const trimMiddleware: FieldMiddleware = async (_ctx, next) => {
  const value = (await next()) as string;
  return value?.trim();
};

const FieldWithOptionalType = Field as (
  returnTypeFunc?: ReturnTypeFunc,
  options?: FieldOptions,
) => PropertyDecorator & MethodDecorator;

/**
 * `@Field(undefined, options)` is accepted by the public overloads (e.g. from
 * a wrapper decorator forwarding an omitted type function), so the options
 * must not be dropped along with the type function.
 */
describeConformance(
  '@Field() with an "undefined" type function',
  {
    upstreamPath: "packages/graphql/tests/decorators/field.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create to pass resolver instances ([new SampleResolver()]) and exercises @Field(undefined, options) runtime behavior (note: Bunest Field overload omits optionality on returnTypeFunc when options are passed).",
  },
  () => {
    @ObjectType()
    class Sample {
      @FieldWithOptionalType(undefined, {
        nullable: true,
        description: "sample description",
        middleware: [trimMiddleware],
      })
      value!: string;
    }

    @Resolver(() => Sample)
    class SampleResolver {
      @Query(() => Sample)
      sample(): Sample {
        return { value: "  sample  " };
      }
    }

    afterAll(() => {
      TypeMetadataStorage.clear();
    });

    it("should keep the options passed as the second argument", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      const schema = await moduleRef
        .get(GraphQLSchemaFactory)
        .create([new SampleResolver()]);

      const field = (schema.getType("Sample") as GraphQLObjectType).getFields()
        .value;
      expect(field).toBeDefined();
      expect(field!.type).not.toBeInstanceOf(GraphQLNonNull);
      expect(field!.description).toBe("sample description");

      const result = await graphql({
        schema,
        source: "{ sample { value } }",
        rootValue: { sample: () => ({ value: "  sample  " }) },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ sample: { value: "sample" } });
    });
  },
);
