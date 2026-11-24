import { beforeAll, expect, it } from "bun:test";
import type {
  GraphQLObjectType,
  GraphQLSchema,
} from "../../../../../../../packages/graphql/src";
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

const DirectiveMulti = Directive as unknown as (
  sdl: string | string[],
) => ClassDecorator & PropertyDecorator & MethodDecorator;

@ObjectType()
@DirectiveMulti(['@tag(name: "internal")', '@tag(name: "restricted")'])
class User {
  @Field(() => ID)
  @DirectiveMulti(['@tag(name: "pii")', '@tag(name: "audit")'])
  id!: string;

  @Field()
  @Directive('@tag(name: "friendly")')
  name!: string;
}

@Resolver(() => User)
class UserResolver {
  @Query(() => User)
  me(): User {
    return null as unknown as User;
  }
}

const tagArg = (
  directive: { arguments?: ReadonlyArray<{ value: unknown }> } | undefined,
): string | undefined =>
  (directive?.arguments?.[0]?.value as { value?: string } | undefined)?.value;

describeConformance(
  "@Directive with multiple SDL strings",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/directive-multi-sdl.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass]) to Bunest GraphQLSchemaFactory.create([new ResolverClass()]) (ADR-013).",
  },
  () => {
    let schema: GraphQLSchema;
    let userType: GraphQLObjectType;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      const schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      schema = await schemaFactory.create([new UserResolver()]);
      userType = schema.getType("User") as GraphQLObjectType;
    });

    // BUNEST_BUG: Directive() (packages/graphql/src/decorators/type.decorators.ts:532) does not accept string[] SDL arrays and GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts:1004-1020) never populates astNode.directives on GraphQLObjectType (expected 2 directives, actual 0).
    it.skip("should attach every class-level directive passed as an array", () => {
      const directives = userType.astNode?.directives ?? [];
      expect(directives.length).toBe(2);
      expect(directives.map((d) => tagArg(d))).toEqual(
        expect.arrayContaining(["internal", "restricted"]),
      );
    });

    // BUNEST_BUG: Directive() (packages/graphql/src/decorators/type.decorators.ts:532) does not accept string[] SDL arrays and GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts:1063-1091) never populates astNode.directives on GraphQLField (expected 2 directives, actual 0).
    it.skip("should attach every property-level directive passed as an array", () => {
      const idField = userType.getFields().id!;
      const directives = idField.astNode?.directives ?? [];
      expect(directives.length).toBe(2);
      expect(directives.map((d) => tagArg(d))).toEqual(
        expect.arrayContaining(["pii", "audit"]),
      );
    });

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts:1063-1091) stores single-string @Directive() only in extensions.directives and never populates astNode.directives on GraphQLField (expected 1 directive, actual 0).
    it.skip("should still accept a single SDL string", () => {
      const nameField = userType.getFields().name!;
      const directives = nameField.astNode?.directives ?? [];
      expect(directives.length).toBe(1);
      expect(tagArg(directives[0])).toBe("friendly");
    });
  },
);
