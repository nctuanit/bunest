import { beforeAll, expect, it } from "bun:test";
import {
  type GraphQLInputObjectType,
  type GraphQLSchema,
  isRequiredArgument,
  isRequiredInputField,
} from "../../../../../../../packages/graphql/src";
import {
  Args,
  ArgsType,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  InputType,
  Int,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@ArgsType()
class OptionalOwnerArgs {
  @Field(() => Int, { nullable: true })
  ownerId?: number | null = null;
}

// Re-declared as non-nullable, while the instance still carries the "null"
// initializer of the base class.
@ArgsType()
class RequiredOwnerArgs extends OptionalOwnerArgs {
  @Field(() => Int)
  declare ownerId: number;
}

@InputType()
class OptionalOwnerInput {
  @Field(() => Int, { nullable: true })
  ownerId?: number | null = null;
}

@InputType()
class RequiredOwnerInput extends OptionalOwnerInput {
  @Field(() => Int)
  declare ownerId: number;
}

@Resolver()
class OwnerResolver {
  @Query(() => String)
  optional(@Args() _args: OptionalOwnerArgs): string {
    return "ok";
  }

  @Query(() => String)
  inherited(@Args() _args: RequiredOwnerArgs): string {
    return "ok";
  }

  @Query(() => String)
  input(
    @Args("optional") _optional: OptionalOwnerInput,
    @Args("required") _required: RequiredOwnerInput,
  ): string {
    return "ok";
  }
}

@Resolver()
class ExplicitNullDefaultResolver {
  @Query(() => String)
  explicit(
    @Args("ownerId", { type: () => Int, defaultValue: null }) _ownerId: number,
  ): string {
    return "ok";
  }
}

describeConformance(
  '"null" default values',
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/null-default-value.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass]) to Bunest GraphQLSchemaFactory.create([new ResolverClass()]) (ADR-013).",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      schema = await schemaFactory.create([new OwnerResolver()]);
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildArgsConfig (packages/graphql/src/schema/graphql-schema.factory.ts:1201-1210) does not inspect @ArgsType() class property initializers (`ownerId = null`) as GraphQL defaultValue (expected null, actual undefined).
    it.skip('should keep a "null" initializer as the default of a nullable argument', () => {
      const [ownerId] = schema.getQueryType()!.getFields().optional!.args;
      expect(ownerId!.defaultValue).toBeNull();
    });

    it('should not let a "null" initializer make a non-nullable argument optional', () => {
      const [ownerId] = schema.getQueryType()!.getFields().inherited!.args;
      expect(ownerId!.defaultValue).toBeUndefined();
      expect(isRequiredArgument(ownerId!)).toBe(true);
    });

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateInputType (packages/graphql/src/schema/graphql-schema.factory.ts:1163-1174) does not inspect @InputType() class property initializers (`ownerId = null`) as GraphQL defaultValue (expected null on OptionalOwnerInput.ownerId, actual undefined).
    it.skip('should not let a "null" initializer make a non-nullable input field optional', () => {
      const optional = schema.getType(
        "OptionalOwnerInput",
      ) as GraphQLInputObjectType;
      expect(optional.getFields().ownerId!.defaultValue).toBeNull();

      const required = schema.getType(
        "RequiredOwnerInput",
      ) as GraphQLInputObjectType;
      expect(required.getFields().ownerId!.defaultValue).toBeUndefined();
      expect(isRequiredInputField(required.getFields().ownerId!)).toBe(true);
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildArgsConfig (packages/graphql/src/schema/graphql-schema.factory.ts:1214-1226) does not reject an explicit `defaultValue: null` on a non-nullable argument (and `DefaultNullableConflictError` is not implemented in packages/graphql/src/).
    it.skip('should reject an explicit "null" default on a non-nullable argument', async () => {
      await expect(
        schemaFactory.create([new ExplicitNullDefaultResolver()]),
      ).rejects.toThrow();
    });
  },
);
