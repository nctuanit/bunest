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

@ObjectType({ isAbstract: true })
@Directive('@key(fields: "id")')
class AbstractBase {
  @Field(() => ID)
  id!: number;
}

@ObjectType()
class DerivedUser extends AbstractBase {
  @Field()
  name!: string;
}

@Resolver(() => DerivedUser)
class DerivedUserResolver {
  @Query(() => DerivedUser)
  user(): DerivedUser {
    return null as unknown as DerivedUser;
  }
}

describeConformance(
  "Directive inheritance from abstract @ObjectType",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/directive-inheritance.spec.ts",
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

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts:1004-1020) never parses @Directive() SDL into GraphQLObjectType.astNode.directives (expected ["key"], actual []).
    it.skip("should propagate class-level directives from an abstract parent to the derived type", async () => {
      const schema = await schemaFactory.create([new DerivedUserResolver()], {
        buildSchemaOptions: { skipCheck: true },
      });

      const derivedType = schema.getType("DerivedUser") as GraphQLObjectType;
      expect(derivedType).toBeDefined();

      const directives = derivedType.astNode?.directives ?? [];
      const directiveNames = directives.map((d) => d.name.value);
      expect(directiveNames).toContain("key");
    });
  },
);
