import { beforeAll, describe, expect, it } from "bun:test";
import type { GraphQLInputObjectType } from "../../../../../../packages/graphql/src";
import {
  Args,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  InputType,
  ObjectType,
  PickType,
  Query,
  Resolver,
  TypeMetadataStorage,
} from "../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../_helpers/index";

@InputType()
class PickSourceInput {
  @Field()
  a!: string;

  @Field()
  b!: string;
}

class PickedInput extends PickType(PickSourceInput, ["a"] as const) {}

describeConformance(
  "PickType duplicate registration & dual-decorated regression",
  {
    upstreamPath:
      "packages/graphql/tests/type-helpers/pick-type-double-register.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts out NestJS internal LazyMetadataStorage (Bunest registers metadata eagerly) and passes resolver instances to GraphQLSchemaFactory.create() (ADR-002, ADR-013).",
  },
  () => {
    describe("PickType duplicate registration regression", () => {
      beforeAll(() => {
        TypeMetadataStorage.compile();
      });

      it("should register the picked input type exactly once", () => {
        const inputs = TypeMetadataStorage.getInputTypesMetadata();
        const pickAbstract = Object.getPrototypeOf(PickedInput) as Function;
        const matches = inputs.filter((item) => item.target === pickAbstract);
        expect(matches).toHaveLength(1);
      });
    });

    describe("PickType with dual-decorated source and target", () => {
      let schemaFactory: GraphQLSchemaFactory;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [GraphQLSchemaBuilderModule],
        }).compile({ logger: false });

        schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      });

      it("should preserve picked fields when the generated type is also used as input", async () => {
        @InputType()
        @ObjectType("PickTypeDualDecoratedParentObject")
        class PickTypeDualDecoratedParent {
          @Field(() => String, { nullable: true })
          nullableField?: string;
        }

        @InputType()
        @ObjectType("PickTypeDualDecoratedChildObject")
        class PickTypeDualDecoratedChild extends PickType(
          PickTypeDualDecoratedParent,
          ["nullableField"] as const,
          ObjectType,
        ) {}

        @Resolver()
        class PickTypeDualDecoratedResolver {
          @Query(() => String)
          pickTypeDualDecorated(
            @Args("filter", {
              type: () => PickTypeDualDecoratedChild,
              nullable: true,
            })
            filter?: PickTypeDualDecoratedChild,
          ): string {
            return filter?.nullableField ?? "";
          }
        }

        const schema = await schemaFactory.create([
          new PickTypeDualDecoratedResolver(),
        ]);
        const inputType = schema.getType(
          "PickTypeDualDecoratedChild",
        ) as GraphQLInputObjectType;

        expect(inputType).toBeDefined();
        expect(inputType.getFields().nullableField).toBeDefined();
      });
    });
  },
);
