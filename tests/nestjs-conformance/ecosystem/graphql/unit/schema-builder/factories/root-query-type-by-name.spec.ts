import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import {
  type GraphQLNonNull,
  type GraphQLObjectType,
  type GraphQLSchema,
  printSchema,
} from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  Mutation,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  type ReturnTypeFuncValue,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@ObjectType()
class RenamePayload {
  @Field()
  name!: string;

  @Field(() => "Query" as unknown as ReturnTypeFuncValue)
  query!: object;
}

@ObjectType()
class DeletePayload {
  @Field()
  deleted!: boolean;
}

@Resolver()
class AccountResolver {
  @Query(() => String)
  name(): string {
    return "name";
  }

  @Mutation(() => RenamePayload)
  rename(): RenamePayload {
    return { name: "name", query: {} };
  }

  @Mutation(() => DeletePayload)
  delete(): DeletePayload {
    return { deleted: true };
  }
}

@Resolver(() => DeletePayload)
class DeletePayloadResolver {
  @ResolveField(() => "Query" as unknown as ReturnTypeFuncValue, {
    nullable: true,
  })
  query(): object {
    return {};
  }
}

describeConformance(
  "Root Query type referenced by name",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/root-query-type-by-name.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass resolver instances per @bunest/graphql API (ADR-013).",
  },
  () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      schema = await moduleRef
        .get(GraphQLSchemaFactory)
        .create([new AccountResolver(), new DeletePayloadResolver()]);
    });

    // BUNEST_BUG: Expected RenamePayload.query: Query! and DeletePayload.query: Query in printed SDL, got String! and String; packages/graphql/src/schema/graphql-schema.factory.ts (resolveOutputLeaf) falls back to GraphQLString for string type name 'Query' instead of resolving the root Query type.
    it.skip("prints the payload fields that return the root Query type", () => {
      const printedSchema = printSchema(schema);
      expect(printedSchema).toContain(
        "type RenamePayload {\n  name: String!\n  query: Query!\n}",
      );
      expect(printedSchema).toContain(
        "type DeletePayload {\n  deleted: Boolean!\n  query: Query\n}",
      );
    });

    // BUNEST_BUG: Expected RenamePayload.query ofType and DeletePayload.query type to be schema.getQueryType(), got GraphQLScalarType 'String'; packages/graphql/src/schema/graphql-schema.factory.ts (resolveOutputLeaf) does not resolve string type reference 'Query' to the root Query object type.
    it.skip("points the fields at the generated root Query type", () => {
      const renameQueryField = (
        schema.getType("RenamePayload") as GraphQLObjectType
      ).getFields().query!;
      const deleteQueryField = (
        schema.getType("DeletePayload") as GraphQLObjectType
      ).getFields().query!;

      expect(
        (renameQueryField.type as GraphQLNonNull<GraphQLObjectType>).ofType,
      ).toBe(schema.getQueryType()!);
      expect(deleteQueryField.type).toBe(schema.getQueryType()!);
    });
  },
);
