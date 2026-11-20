import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import { type GraphQLSchema, graphql } from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Field,
  type FieldMiddleware,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  InterfaceType,
  ObjectType,
  Query,
  Resolver,
  UseFieldMiddleware,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

const wrap =
  (name: string): FieldMiddleware =>
  async (_ctx, next) =>
    `${name}(${await next()})`;

const value = () => ({
  id: "1",
  ownerEmail: "value",
  internalNotes: "value",
});

@InterfaceType()
abstract class Base {
  @Field(() => ID)
  id!: string;

  @UseFieldMiddleware(wrap("decorator"))
  @Field({ middleware: [wrap("option")] })
  ownerEmail!: string;
}

// The layout of the `IRecipe extends Base` code-first fixture: the object
// type lists `IRecipe` in `implements`, and reaches `Base` through `extends`.
@InterfaceType()
abstract class IRecipe extends Base {
  @Field({ middleware: [wrap("option")] })
  internalNotes!: string;
}

@ObjectType({ implements: () => IRecipe })
class Recipe extends IRecipe {}

@ObjectType()
class Note extends Base {}

@ObjectType({ isAbstract: true })
class AbstractNote extends Base {}

@ObjectType()
class LeafNote extends AbstractNote {}

@Resolver()
class InterfaceFieldMiddlewareResolver {
  @Query(() => Recipe)
  recipe(): Recipe {
    return value() as unknown as Recipe;
  }

  @Query(() => Note)
  note(): Note {
    return value() as unknown as Note;
  }

  @Query(() => LeafNote)
  leafNote(): LeafNote {
    return value() as unknown as LeafNote;
  }
}

describeConformance(
  "Field middleware on fields inherited from an @InterfaceType() class",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/interface-field-middleware.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass], { fieldMiddleware }) to Bunest GraphQLSchemaFactory.create([new ResolverClass()], { buildSchemaOptions: { fieldMiddleware } }); Bunest binds live resolver methods rather than leaving them unbound for rootValue (ADR-013).",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
    });

    const createSchema = () =>
      schemaFactory.create([new InterfaceFieldMiddlewareResolver()], {
        buildSchemaOptions: {
          fieldMiddleware: [wrap("global")],
        },
      });

    // BUNEST_BUG: GraphQLSchemaFactory.resolveOutputLeaf (packages/graphql/src/schema/graphql-schema.factory.ts:791) and getOrCreateInterfaceType (:850) use prototype-walking MetadataRegistry.has/get instead of hasOwn/getOwn, misclassifying @ObjectType() subclasses extending an @InterfaceType() (`Note extends Base`, `LeafNote extends AbstractNote`) as duplicate GraphQLInterfaceType("Base") and crashing schema creation with "Schema must contain uniquely named types but contains multiple types named \"Base\"."
    it.skip('should run the middleware of an interface field reached through "extends"', async () => {
      const schema = await createSchema();
      const result = await graphql({
        schema,
        source: "{ recipe { ownerEmail internalNotes } }",
        rootValue: { recipe: value },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        recipe: {
          ownerEmail: "global(option(decorator(value)))",
          internalNotes: "global(option(value))",
        },
      });
    });

    // BUNEST_BUG: GraphQLSchemaFactory.resolveOutputLeaf (packages/graphql/src/schema/graphql-schema.factory.ts:791) and getOrCreateInterfaceType (:850) use prototype-walking MetadataRegistry.has/get instead of hasOwn/getOwn, misclassifying @ObjectType() classes extending an @InterfaceType() (`Note extends Base`, `LeafNote extends AbstractNote`) as duplicate GraphQLInterfaceType("Base") and crashing schema creation.
    it.skip("should run the middleware when an object type extends the interface class", async () => {
      const schema = await createSchema();
      const result = await graphql({
        schema,
        source: "{ note { id ownerEmail } leafNote { id ownerEmail } }",
        rootValue: { note: value, leafNote: value },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        note: {
          id: "global(1)",
          ownerEmail: "global(option(decorator(value)))",
        },
        leafNote: {
          id: "global(1)",
          ownerEmail: "global(option(decorator(value)))",
        },
      });
    });
  },
);
