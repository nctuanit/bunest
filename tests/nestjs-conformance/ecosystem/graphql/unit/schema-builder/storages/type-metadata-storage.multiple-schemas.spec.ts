import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import type {
  GraphQLObjectType,
  GraphQLSchema,
} from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Args,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  Int,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

/**
 * One process can build several schemas from the same storage, each from its
 * own resolver classes (e.g. `GraphQLModule.forRoot({ include })` per
 * endpoint). A `@ResolveField()` of one schema must not leak into another one.
 */

@ObjectType()
class Account {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  bio!: string;
}

@Resolver(() => Account)
class AdminAccountResolver {
  @Query(() => [Account])
  adminAccounts(): Account[] {
    return [];
  }

  @ResolveField(() => String)
  secret(): string {
    return "secret";
  }

  @ResolveField(() => [String])
  tags(
    @Args("first", { type: () => Int, nullable: true }) _first?: number,
  ): string[] {
    return [];
  }

  @ResolveField(() => String)
  bio(@Args("raw", { type: () => Boolean }) _raw: boolean): string {
    return "";
  }
}

@Resolver(() => Account)
class PublicAccountResolver {
  @Query(() => [Account])
  accounts(): Account[] {
    return [];
  }

  @ResolveField(() => [String])
  tags(@Args("first", { type: () => Int }) _first: number): string[] {
    return [];
  }
}

describeConformance(
  "TypeMetadataStorage - several schemas in one process",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/storages/type-metadata-storage.multiple-schemas.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass resolver instances per @bunest/graphql API (ADR-013).",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;

    const getAccountFields = (schema: GraphQLSchema) =>
      (schema.getType("Account") as GraphQLObjectType).getFields();
    const getArgType = (schema: GraphQLSchema, field: string, arg: string) =>
      getAccountFields(schema)
        [field]?.args.find((item) => item.name === arg)
        ?.type.toString();

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
    });

    it("should build each schema from its own field resolvers only", async () => {
      const adminSchema = await schemaFactory.create([
        new AdminAccountResolver(),
      ]);
      const publicSchema = await schemaFactory.create([
        new PublicAccountResolver(),
      ]);
      const adminSchemaAgain = await schemaFactory.create([
        new AdminAccountResolver(),
      ]);

      expect(getAccountFields(publicSchema).secret).toBeUndefined();
      expect(getArgType(publicSchema, "tags", "first")).toBe("Int!");
      expect(getAccountFields(publicSchema).bio?.args).toEqual([]);

      for (const schema of [adminSchema, adminSchemaAgain]) {
        expect(getAccountFields(schema).secret).toBeDefined();
        expect(getArgType(schema, "tags", "first")).toBe("Int");
        expect(getArgType(schema, "bio", "raw")).toBe("Boolean!");
      }
    });
  },
);
