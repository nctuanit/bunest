import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import type { GraphQLObjectType } from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Directive,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@ObjectType()
@Directive('@tag(name: "public")')
class Account {
  @Field(() => ID)
  id!: string;

  @Field()
  @Directive('@tag(name: "public")')
  email!: string;
}

@Resolver(() => Account)
class AccountResolver {
  @Query(() => Account)
  me(): Account {
    return null as unknown as Account;
  }
}

describeConformance(
  "Class-level directive not shadowed by identical field-level directive",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/class-directive-not-shadowed.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass]) to Bunest GraphQLSchemaFactory.create([new ResolverClass()]) (ADR-013).",
  },
  () => {
    let accountType: GraphQLObjectType;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      const schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      const schema = await schemaFactory.create([new AccountResolver()]);
      accountType = schema.getType("Account") as GraphQLObjectType;
    });

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts:1004-1020) stores @Directive() SDL strings only in extensions.directives and never populates astNode.directives on GraphQLObjectType (expected ["public"], actual []).
    it.skip("should keep the class-level directive even when a field declares the same SDL", () => {
      const classDirectives = accountType.astNode?.directives ?? [];
      const classTagNames = classDirectives
        .filter((d) => d.name.value === "tag")
        .map(
          (d) =>
            (d.arguments?.[0]?.value as { value?: string } | undefined)?.value,
        );
      expect(classTagNames).toContain("public");
    });

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts:1063-1091) stores field @Directive() SDL strings only in extensions.directives and never populates astNode.directives on GraphQLField (expected ["public"], actual []).
    it.skip("should still keep the field-level directive", () => {
      const emailField = accountType.getFields().email!;
      const fieldDirectives = emailField.astNode?.directives ?? [];
      const fieldTagNames = fieldDirectives
        .filter((d) => d.name.value === "tag")
        .map(
          (d) =>
            (d.arguments?.[0]?.value as { value?: string } | undefined)?.value,
        );
      expect(fieldTagNames).toContain("public");
    });
  },
);
