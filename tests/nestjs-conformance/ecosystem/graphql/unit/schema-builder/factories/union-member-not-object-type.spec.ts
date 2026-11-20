import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import {
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  ObjectType,
  Query,
  Resolver,
  createUnionType,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@ObjectType()
class RegisteredCat {
  @Field(() => ID)
  id!: string;
}

class StrayDog {
  @Field(() => ID)
  id!: string;
}

const Pet = createUnionType({
  name: "Pet",
  types: () => [RegisteredCat, StrayDog as any] as const,
});

@Resolver()
class PetResolver {
  @Query(() => Pet)
  pet(): unknown {
    return null;
  }
}

describeConformance(
  "UnionDefinitionFactory error path",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/union-member-not-object-type.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass resolver instances per @bunest/graphql API (ADR-013).",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
    });

    // BUNEST_BUG: Expected schemaFactory.create() to reject with 'Cannot build the "Pet" union: its member "StrayDog" is not registered as a @ObjectType().', but it resolved without throwing; packages/graphql/src/schema/graphql-schema.factory.ts (getOrCreateUnionType:909-912 / getOrCreateObjectType:975-985) silently synthesizes a GraphQLObjectType for undecorated union members instead of validating @ObjectType() registration.
    it.skip("should throw a descriptive error when a union member is not an @ObjectType", async () => {
      await expect(
        schemaFactory.create([new PetResolver()]),
      ).rejects.toThrow(
        /Cannot build the "Pet" union: its member "StrayDog" is not registered as a @ObjectType\(\)\./,
      );
    });
  },
);
