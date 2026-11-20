import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import {
  Query,
  Resolver,
  TypeMetadataStorage,
} from "../../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../../_helpers/index";

/**
 * Handlers declared on a base resolver are re-attributed to the class that extends it, so that the
 * resolvers explorer instantiates the derived class. The rewrite is applied in registration order
 * and can move the same handler more than once, which is what these cases pin down.
 */

describeConformance(
  "TypeMetadataStorage extended resolvers",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/storages/type-metadata-storage.extended-resolvers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts upstream LazyMetadataStorage.load() to @bunest/graphql eager decorator registration into TypeMetadataStorage (ADR-013).",
  },
  () => {
    let LeafResolverRef: Function;

    beforeAll(() => {
      @Resolver()
      class BaseResolver {
        @Query(() => String)
        inheritedQuery(): string {
          return "base";
        }
      }

      @Resolver()
      class MidResolver extends BaseResolver {
        @Query(() => String)
        midQuery(): string {
          return "mid";
        }
      }

      @Resolver()
      class LeafResolver extends MidResolver {}

      LeafResolverRef = LeafResolver;
      TypeMetadataStorage.compile();
    });

    const queryFor = (schemaName: string) =>
      TypeMetadataStorage.getQueriesMetadata().find(
        (query) => query.schemaName === schemaName,
      ) as
        | { target: Function; classMetadata?: { target: Function } }
        | undefined;

    // BUNEST_BUG: Expected midQuery.target and classMetadata.target to be LeafResolver after TypeMetadataStorage.compile(), got target=MidResolver and classMetadata=undefined; packages/graphql/src/schema/type-metadata.storage.ts (compile:349-357) does not re-attribute base resolver queries to derived resolvers or attach classMetadata.
    it.skip("should re-attribute a query declared on a base resolver to the derived resolver", () => {
      const query = queryFor("midQuery");

      expect(query?.target).toBe(LeafResolverRef);
      expect(query?.classMetadata?.target).toBe(LeafResolverRef);
    });

    // BUNEST_BUG: Expected inheritedQuery.target and classMetadata.target to be LeafResolver across BaseResolver -> MidResolver -> LeafResolver, got target=BaseResolver and classMetadata=undefined; packages/graphql/src/schema/type-metadata.storage.ts (compile:349-357) does not walk resolver inheritance chains during compile().
    it.skip("should follow the whole chain when a resolver is extended more than once", () => {
      // inheritedQuery starts on BaseResolver, moves to MidResolver, then on to LeafResolver.
      const query = queryFor("inheritedQuery");

      expect(query?.target).toBe(LeafResolverRef);
      expect(query?.classMetadata?.target).toBe(LeafResolverRef);
    });
  },
);
