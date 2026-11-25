import { beforeAll, expect, it } from "bun:test";
import type {
  GraphQLInputObjectType,
  GraphQLSchema,
} from "../../../../../../../packages/graphql/src";
import {
  Args,
  Directive,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  InputType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@InputType({ isOneOf: true, isAbstract: true })
abstract class LookupInput {
  @Field(() => ID, { nullable: true })
  id?: string;

  @Field({ nullable: true })
  slug?: string;
}

@InputType()
class ProjectLookupInput extends LookupInput {}

@InputType()
class TeamLookupInput extends ProjectLookupInput {
  @Field({ nullable: true })
  handle?: string;
}

@InputType({ isOneOf: false })
class ProjectFilterInput extends LookupInput {}

@InputType()
@Directive("@oneOf")
class AccountSelector {
  @Field(() => ID, { nullable: true })
  id?: string;

  @Field({ nullable: true })
  email?: string;
}

@InputType()
class DerivedAccountSelector extends AccountSelector {}

@InputType()
class PlainInput {
  @Field({ nullable: true })
  name?: string;
}

@Resolver()
class LookupResolver {
  @Query(() => String)
  lookup(
    @Args("project") _project: ProjectLookupInput,
    @Args("team") _team: TeamLookupInput,
    @Args("filter") _filter: ProjectFilterInput,
    @Args("account") _account: AccountSelector,
    @Args("derivedAccount") _derivedAccount: DerivedAccountSelector,
    @Args("plain") _plain: PlainInput,
  ): string {
    return "ok";
  }
}

describeConformance(
  "OneOf input types",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/one-of-input-type.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass resolver instances ([new LookupResolver()]) per @bunest/graphql API (ADR-013).",
  },
  () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      schema = await moduleRef
        .get(GraphQLSchemaFactory)
        .create([new LookupResolver()]);
    });

    const isOneOf = (name: string) =>
      (schema.getType(name) as GraphQLInputObjectType).isOneOf;

    it('should inherit "isOneOf" from a parent input type', () => {
      expect(isOneOf("ProjectLookupInput")).toBe(true);
      expect(isOneOf("TeamLookupInput")).toBe(true);
    });

    it('should let a derived input type opt out with "isOneOf: false"', () => {
      expect(isOneOf("ProjectFilterInput")).toBe(false);
    });

    it('should mark an input type with the "@oneOf" directive as OneOf', () => {
      expect(isOneOf("AccountSelector")).toBe(true);
      expect(isOneOf("DerivedAccountSelector")).toBe(true);
      expect(isOneOf("PlainInput")).toBe(false);
    });
  },
);
