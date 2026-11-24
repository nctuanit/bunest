import { beforeAll, expect, it } from "bun:test";
import {
  graphql,
  type GraphQLSchema,
} from "../../../../../../../packages/graphql/src";
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
  createUnionType,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

const requireClearance: FieldMiddleware = async () => "redacted";

@InterfaceType()
abstract class Node {
  @Field(() => ID)
  id!: string;
}

@ObjectType({ implements: () => [Node] })
class Document implements Node {
  id!: string;

  @Field()
  content!: string;
}

// Implements `Node` through its parent class only.
@ObjectType()
class ClassifiedDocument extends Document {
  @Field({ middleware: [requireClearance] })
  declare content: string;
}

@ObjectType({ implements: () => [Node] })
class TopSecretDocument extends ClassifiedDocument {}

// Not referenced by any field, so it is not part of the schema.
@ObjectType()
class DraftDocument extends Document {}

const ParentFirst = createUnionType({
  name: "ParentFirst",
  types: () => [Document, ClassifiedDocument] as const,
});

@Resolver()
class NodesResolver {
  nodeValue: unknown = null;
  parentFirstValue: unknown = null;

  @Query(() => Node)
  node(): Node {
    return this.nodeValue as Node;
  }

  @Query(() => ParentFirst)
  parentFirst(): unknown {
    return this.parentFirstValue;
  }

  @Query(() => ClassifiedDocument)
  classifiedDocument(): ClassifiedDocument {
    return null as unknown as ClassifiedDocument;
  }

  @Query(() => TopSecretDocument)
  topSecretDocument(): TopSecretDocument {
    return null as unknown as TopSecretDocument;
  }
}

describeConformance(
  "Default resolveType of code-first abstract types",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/resolve-type-most-derived-class.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass a stateful NodesResolver instance returning the test object directly (Bunest binds resolver methods on Query fields rather than relying on rootValue; ADR-013).",
  },
  () => {
    let schema: GraphQLSchema;
    let resolver: NodesResolver;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      resolver = new NodesResolver();
      schema = await moduleRef.get(GraphQLSchemaFactory).create([resolver]);
    });

    const create = <T extends object>(type: new () => T) =>
      Object.assign(new type(), { id: "1", content: "secret" });

    const source = (field: string) => `{
    ${field} {
      __typename
      ... on Document { content }
      ... on ClassifiedDocument { content }
      ... on TopSecretDocument { content }
    }
  }`;

    for (const [typename, type, content] of [
      ["Document", Document, "secret"],
      ["ClassifiedDocument", ClassifiedDocument, "redacted"],
      ["TopSecretDocument", TopSecretDocument, "redacted"],
    ] as const) {
      it(`should resolve an interface value to its most derived class (${typename})`, async () => {
        resolver.nodeValue = create(type);
        const result = await graphql({
          schema,
          source: source("node"),
        });

        expect(result.errors).toBeUndefined();
        expect(result.data).toEqual({
          node: { __typename: typename, content },
        });
      });
    }

    it("should resolve a union value to its most derived class", async () => {
      resolver.parentFirstValue = create(ClassifiedDocument);
      const result = await graphql({
        schema,
        source: `{
        parentFirst {
          __typename
          ... on Document { content }
          ... on ClassifiedDocument { content }
        }
      }`,
      });

      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        parentFirst: { __typename: "ClassifiedDocument", content: "redacted" },
      });
    });

    it("should fall back to a class in the schema for a class outside it", async () => {
      expect(schema.getType("DraftDocument")).toBeUndefined();

      resolver.nodeValue = create(DraftDocument);
      const result = await graphql({
        schema,
        source: source("node"),
      });

      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        node: { __typename: "Document", content: "secret" },
      });
    });
  },
);
