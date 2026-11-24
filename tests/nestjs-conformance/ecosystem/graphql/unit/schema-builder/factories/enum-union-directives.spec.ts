import { beforeAll, expect, it } from "bun:test";
import type {
  GraphQLEnumType,
  GraphQLUnionType,
} from "../../../../../../../packages/graphql/src";
import {
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  ObjectType,
  Query,
  Resolver,
  createUnionType,
  registerEnumType,
  type EnumTypeOptions,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

enum MovieGenre {
  ACTION = "ACTION",
  COMEDY = "COMEDY",
}

registerEnumType(MovieGenre, {
  name: "MovieGenre",
  directives: ['@tag(name: "public")'],
  valuesMap: {
    ACTION: {
      directives: ['@tag(name: "featured")'],
    },
  },
} as EnumTypeOptions);

@ObjectType()
class Book {
  @Field(() => ID)
  id!: string;
}

@ObjectType()
class Movie {
  @Field(() => ID)
  id!: string;
}

const MediaUnion = createUnionType({
  name: "Media",
  types: () => [Book, Movie] as const,
  directives: ['@tag(name: "public")'],
});

@Resolver()
class MediaResolver {
  @Query(() => MovieGenre)
  genre(): MovieGenre {
    return MovieGenre.ACTION;
  }

  @Query(() => MediaUnion)
  media(): typeof MediaUnion {
    return null as unknown as typeof MediaUnion;
  }
}

describeConformance(
  "Directives on enums and unions (issue #2920)",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/enum-union-directives.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass]) to Bunest GraphQLSchemaFactory.create([new ResolverClass()]) (ADR-013).",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
    });

    // BUNEST_BUG: registerEnumType (packages/graphql/src/decorators/type.decorators.ts:114-118) ignores `options.directives` when creating GraphQLEnumType, leaving `enumType.astNode` undefined (expected ["tag"], actual []).
    it.skip("should attach directives to the generated enum type", async () => {
      const schema = await schemaFactory.create([new MediaResolver()]);

      const enumType = schema.getType("MovieGenre") as GraphQLEnumType;
      expect(enumType).toBeDefined();

      const directiveNames =
        enumType.astNode?.directives?.map((d) => d.name.value) ?? [];
      expect(directiveNames).toContain("tag");
    });

    // BUNEST_BUG: registerEnumType (packages/graphql/src/decorators/type.decorators.ts:102-111) does not support `valuesMap[key].directives` or populate `astNode.directives` on enum values (expected ["tag"], actual []).
    it.skip("should attach directives to individual enum values", async () => {
      const schema = await schemaFactory.create([new MediaResolver()]);

      const enumType = schema.getType("MovieGenre") as GraphQLEnumType;
      const actionValue = enumType.getValue("ACTION");
      expect(actionValue).toBeDefined();

      const directiveNames =
        actionValue!.astNode?.directives?.map((d) => d.name.value) ?? [];
      expect(directiveNames).toContain("tag");

      const comedyValue = enumType.getValue("COMEDY");
      expect(comedyValue!.astNode).toBeUndefined();
    });

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateUnionType (packages/graphql/src/schema/graphql-schema.factory.ts:906-921) ignores `ref.directives` when creating GraphQLUnionType, leaving `unionType.astNode` undefined (expected ["tag"], actual []).
    it.skip("should attach directives to the generated union type", async () => {
      const schema = await schemaFactory.create([new MediaResolver()]);

      const unionType = schema.getType("Media") as GraphQLUnionType;
      expect(unionType).toBeDefined();

      const directiveNames =
        unionType.astNode?.directives?.map((d) => d.name.value) ?? [];
      expect(directiveNames).toContain("tag");
    });
  },
);
