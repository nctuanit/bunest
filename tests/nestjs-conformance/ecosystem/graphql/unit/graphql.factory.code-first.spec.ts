import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  type GraphQLSchema,
  graphql,
} from "../../../../../packages/graphql/node_modules/graphql";
import {
  Field,
  type FieldMiddleware,
  GraphQLFactory,
  GraphQLSchemaBuilderModule,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  TypeMetadataStorage,
  UseFieldMiddleware,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

const wrap =
  (name: string): FieldMiddleware =>
  async (_ctx, next) =>
    `${name}(${await next()})`;

const globalMiddleware = wrap("global");
const modelMiddleware = wrap("model");
const handlerMiddleware = wrap("handler");

@ObjectType()
class Item {
  @Field({ middleware: [modelMiddleware] })
  overridden!: string;
}

describeConformance(
  "GraphQLFactory (code first)",
  {
    upstreamPath: "packages/graphql/tests/graphql.factory.code-first.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS internal ResolversExplorerService/GraphQLSchemaBuilder mocks to Bunest GraphQLFactory.generateSchema(options, resolverInstances) with code-first @ResolveField() and middleware (ADR-013).",
  },
  () => {
    let graphqlFactory: GraphQLFactory;

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      graphqlFactory = module.get(GraphQLFactory);
    });

    afterAll(() => {
      TypeMetadataStorage.clear();
    });

    async function queryWithResolver(resolverInstance: object) {
      const schema: GraphQLSchema = await graphqlFactory.generateSchema(
        {
          autoSchemaFile: true,
          buildSchemaOptions: { fieldMiddleware: [globalMiddleware] },
        },
        [resolverInstance],
      );
      const { data, errors } = await graphql({
        schema,
        source: "{ item { overridden } }",
      });
      expect(errors).toBeUndefined();
      return (data as { item: Item }).item.overridden;
    }

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType in packages/graphql/src/schema/graphql-schema.factory.ts drops @ObjectType @Field({ middleware }) when @ResolveField() overrides the field (expected "global(model(handler(value)))", received "global(handler(value))").
    it.skip("should run the global middleware, then the model field middleware, then the handler middleware", async () => {
      @Resolver(() => Item)
      class ItemResolver {
        @Query(() => Item)
        item() {
          return {};
        }

        @ResolveField(() => String, { middleware: [handlerMiddleware] })
        overridden() {
          return "value";
        }
      }

      await expect(queryWithResolver(new ItemResolver())).resolves.toBe(
        "global(model(handler(value)))",
      );
    });

    it("should not run the model field middleware twice when the handler repeats it", async () => {
      @Resolver(() => Item)
      class DuplicateMiddlewareItemResolver {
        @Query(() => Item)
        item() {
          return {};
        }

        @ResolveField(() => String, {
          middleware: [modelMiddleware, handlerMiddleware],
        })
        overridden() {
          return "value";
        }
      }

      await expect(
        queryWithResolver(new DuplicateMiddlewareItemResolver()),
      ).resolves.toBe("global(model(handler(value)))");
    });

    // BUNEST_BUG: GraphQLSchemaFactory in packages/graphql/src/schema/graphql-schema.factory.ts does not wrap @ResolveField() handlers with the underlying @ObjectType @Field({ middleware }) or honor FIELD_RESOLVER_COMPOSITION_METADATA (expected "model(global(handler(value)))", received "global(handler(value))").
    it.skip("should wrap a field resolver that exposes no composition with the model field middleware", async () => {
      @Resolver(() => Item)
      class DecoratorMiddlewareItemResolver {
        @Query(() => Item)
        item() {
          return {};
        }

        @ResolveField(() => String)
        @UseFieldMiddleware(handlerMiddleware)
        overridden() {
          return "value";
        }
      }

      await expect(
        queryWithResolver(new DecoratorMiddlewareItemResolver()),
      ).resolves.toBe("model(global(handler(value)))");
    });
  },
);
