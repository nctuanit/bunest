import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import type { GraphQLInputObjectType, GraphQLObjectType } from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Args,
  Extensions,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  InputType,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@ObjectType()
class OType {
  @Field(() => String)
  @Extensions({ key: "value" })
  OtypeMember!: string;
}

@InputType()
class IType {
  @Field(() => String)
  @Extensions({ key: "value" })
  ItypeMember!: string;
}

@Resolver()
class ExtensionsResolver {
  @Query(() => OType)
  getOType(@Args("input", { type: () => IType }) _input: IType): OType {
    return null as unknown as OType;
  }
}

describeConformance(
  "@Extensions on @Field in @InputType (issue #3328)",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/extensions-on-input-type.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass], { skipCheck: true }) to Bunest GraphQLSchemaFactory.create([new ResolverClass()], { buildSchemaOptions: { skipCheck: true } }) (ADR-013).",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
    });

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateInputType (packages/graphql/src/schema/graphql-schema.factory.ts:1167-1174) omits `extensions` from GraphQLInputFieldConfig, so @Extensions() on @InputType() fields is dropped (expected "value", actual undefined).
    it.skip("exposes @Extensions on @Field for both @ObjectType and @InputType (parity)", async () => {
      const schema = await schemaFactory.create([new ExtensionsResolver()], {
        buildSchemaOptions: { skipCheck: true },
      });

      const objectType = schema.getType("OType") as GraphQLObjectType;
      expect(objectType).toBeDefined();
      const objectFields = objectType.getFields();
      expect(objectFields.OtypeMember!.extensions).toBeDefined();
      expect(objectFields.OtypeMember!.extensions.key).toBe("value");

      const inputType = schema.getType("IType") as GraphQLInputObjectType;
      expect(inputType).toBeDefined();
      const inputFields = inputType.getFields();
      // Regression: pre-fix this map was empty for input fields.
      expect(inputFields.ItypeMember!.extensions).toBeDefined();
      expect(inputFields.ItypeMember!.extensions.key).toBe("value");
    });
  },
);
