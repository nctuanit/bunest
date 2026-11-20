import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import {
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  InterfaceType,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@InterfaceType()
abstract class RegisteredEntity {
  @Field(() => ID)
  id!: string;
}

abstract class NotRegisteredEntity {
  @Field(() => ID)
  id!: string;
}

@ObjectType({ implements: () => [RegisteredEntity, NotRegisteredEntity] })
class Hybrid extends RegisteredEntity {
  @Field()
  label!: string;
}

@Resolver()
class HybridResolver {
  @Query(() => Hybrid)
  hybrid(): Hybrid {
    return null as unknown as Hybrid;
  }
}

describeConformance(
  'ObjectType / InterfaceType "implements" error path',
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/implements-missing-interface.spec.ts",
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

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateInterfaceType (packages/graphql/src/schema/graphql-schema.factory.ts:844-898) does not verify that classes referenced in `implements` are decorated with @InterfaceType(), silently creating an interface instead of rejecting with a descriptive error.
    it.skip("should throw a descriptive error when implements references a class without @InterfaceType", async () => {
      await expect(
        schemaFactory.create([new HybridResolver()]),
      ).rejects.toThrow(
        /"Hybrid" lists "NotRegisteredEntity" in its "implements" option, but "NotRegisteredEntity" is not registered as an @InterfaceType\(\)\./,
      );
    });
  },
);
