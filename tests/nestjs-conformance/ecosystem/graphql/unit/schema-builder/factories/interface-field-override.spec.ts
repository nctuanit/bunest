import { beforeAll, expect, it } from "bun:test";
import {
  type GraphQLObjectType,
  type GraphQLSchema,
  graphql,
} from "../../../../../../../packages/graphql/src";
import {
  Extensions,
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

const documentValue = () => ({ id: "1", author: "value", seal: "value" });

@InterfaceType()
abstract class Document {
  @Field(() => ID)
  id!: string;

  @Field({ description: "base" })
  author!: string;
}

@InterfaceType({ implements: () => [Document] })
abstract class ConfidentialDocument implements Document {
  id!: string;

  @UseFieldMiddleware(wrap("decorator"))
  @Extensions({ role: "ADMIN" })
  @Field({ description: "override", middleware: [wrap("option")] })
  author!: string;
}

@InterfaceType({ implements: () => [ConfidentialDocument, Document] })
abstract class SealedDocument implements ConfidentialDocument {
  id!: string;
  author!: string;

  @Field()
  seal!: string;
}

@ObjectType({ implements: () => [ConfidentialDocument, Document] })
class DescendantFirst implements ConfidentialDocument {
  id!: string;
  author!: string;
}

@ObjectType({ implements: () => [Document, ConfidentialDocument] })
class AncestorFirst implements ConfidentialDocument {
  id!: string;
  author!: string;
}

@ObjectType({
  implements: () => [SealedDocument, ConfidentialDocument, Document],
})
class Sealed implements SealedDocument {
  id!: string;
  author!: string;
  seal!: string;
}

@Resolver()
class DocumentsResolver {
  @Query(() => DescendantFirst)
  descendantFirst(): DescendantFirst {
    return documentValue() as unknown as DescendantFirst;
  }

  @Query(() => AncestorFirst)
  ancestorFirst(): AncestorFirst {
    return documentValue() as unknown as AncestorFirst;
  }

  @Query(() => Sealed)
  sealed(): Sealed {
    return documentValue() as unknown as Sealed;
  }
}

describeConformance(
  "A field redeclared by an interface that implements another interface",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/interface-field-override.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass]) to Bunest GraphQLSchemaFactory.create([new ResolverClass()]); Bunest binds live resolver methods rather than leaving them unbound for rootValue (ADR-013).",
  },
  () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      schema = await moduleRef
        .get(GraphQLSchemaFactory)
        .create([new DocumentsResolver()]);
    });

    it.each(["DescendantFirst", "AncestorFirst", "Sealed"])(
      "should build %s.author from the closest declaration",
      (typeName) => {
        const author = (
          schema.getType(typeName) as GraphQLObjectType
        ).getFields().author!;

        expect(author.description).toBe("override");
        expect(author.extensions).toMatchObject({ role: "ADMIN" });
      },
    );

    it("should run the middleware of the closest declaration", async () => {
      const result = await graphql({
        schema,
        source:
          "{ descendantFirst { author } ancestorFirst { author } sealed { author seal } }",
        rootValue: {
          descendantFirst: documentValue,
          ancestorFirst: documentValue,
          sealed: documentValue,
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        descendantFirst: { author: "option(decorator(value))" },
        ancestorFirst: { author: "option(decorator(value))" },
        sealed: { author: "option(decorator(value))", seal: "value" },
      });
    });
  },
);
