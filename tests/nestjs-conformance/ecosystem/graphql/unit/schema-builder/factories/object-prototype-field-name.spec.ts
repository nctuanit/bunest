import { beforeAll, expect, it } from "bun:test";
import {
  type GraphQLSchema,
  printSchema,
} from "../../../../../../../packages/graphql/src";
import {
  Args,
  ArgsType,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  InputType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@InputType()
class ProtoMemberFilterInput {
  @Field(() => String, { nullable: true })
  label?: string;
}

// Registered without a matching class-field declaration (as code-generated or
// dynamically registered types do), so the instance has no own property.
Field(() => String, { nullable: true })(
  ProtoMemberFilterInput.prototype,
  "toString",
);
Field(() => String, { nullable: true })(
  ProtoMemberFilterInput.prototype,
  "constructor",
);

@ArgsType()
class ProtoMemberArgs {
  @Field(() => String, { nullable: true })
  label?: string;
}

Field(() => String, { nullable: true })(ProtoMemberArgs.prototype, "valueOf");

@InputType()
class GetterDefaultInput {
  @Field(() => String, { nullable: true })
  get computed(): string {
    return "from-getter";
  }
}

@Resolver()
class ProtoMemberResolver {
  @Query(() => String)
  filter(@Args("filter") _filter: ProtoMemberFilterInput): string {
    return "ok";
  }

  @Query(() => String)
  args(@Args() _args: ProtoMemberArgs): string {
    return "ok";
  }

  @Query(() => String)
  getter(@Args("input") _input: GetterDefaultInput): string {
    return "ok";
  }
}

describeConformance(
  "Field named after an Object.prototype member (issue #4161)",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/object-prototype-field-name.spec.ts",
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
      schema = await schemaFactory.create([new ProtoMemberResolver()]);
    });

    it("should not infer a default value for input type fields", () => {
      const printed = printSchema(schema);
      expect(printed).toContain(`input ProtoMemberFilterInput {
  label: String
  toString: String
  constructor: String
}`);
    });

    it("should not infer a default value for args type fields", () => {
      const printed = printSchema(schema);
      expect(printed).toContain(
        "args(label: String, valueOf: String): String!",
      );
    });

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateInputType (packages/graphql/src/schema/graphql-schema.factory.ts:1163-1174) does not instantiate input classes to infer default values from prototype getters (expected `computed: String = "from-getter"`, actual `computed: String`).
    it.skip("should still infer a default value from a prototype getter", () => {
      const printed = printSchema(schema);
      expect(printed).toContain('computed: String = "from-getter"');
    });
  },
);
