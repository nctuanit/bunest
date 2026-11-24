import { beforeAll, expect, it, spyOn } from "bun:test";
import { Logger } from "../../../../../../../packages/core/src/common";
import {
  Query,
  Resolver,
  TypeMetadataStorage,
} from "../../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../../_helpers/index";

/**
 * Two resolvers on separate branches extending the same base is ambiguous: the base's handlers can
 * only be attributed to one of them. That resolves by registration order, so warn about the one
 * that silently misses out.
 */

describeConformance(
  "TypeMetadataStorage extended resolvers - shared base class",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/storages/type-metadata-storage.extended-resolvers-conflict.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts upstream LazyMetadataStorage.load() to @bunest/graphql eager decorator registration into TypeMetadataStorage (ADR-013).",
  },
  () => {
    let warnings: string[];
    let FirstDerivedResolverRef: Function;

    beforeAll(() => {
      const warn = spyOn(Logger.prototype, "warn").mockImplementation(
        () => undefined,
      );

      @Resolver()
      class SharedBaseResolver {
        @Query(() => String)
        sharedQuery(): string {
          return "shared";
        }
      }

      @Resolver()
      class FirstDerivedResolver extends SharedBaseResolver {}

      @Resolver()
      class SecondDerivedResolver extends SharedBaseResolver {}

      FirstDerivedResolverRef = FirstDerivedResolver;
      void SecondDerivedResolver;

      TypeMetadataStorage.compile();

      warnings = warn.mock.calls.map(([message]) => String(message));
      warn.mockRestore();
    });

    it("should attribute the handlers to the resolver registered first", () => {
      const query = TypeMetadataStorage.getQueriesMetadata().find(
        (item) => item.schemaName === "sharedQuery",
      );

      expect(query?.target).toBe(FirstDerivedResolverRef);
    });

    it("should warn that the other resolver never serves the handlers", () => {
      const message = warnings.find((text) =>
        text.includes("SharedBaseResolver"),
      );

      expect(message).toBeDefined();
      expect(message).toContain("FirstDerivedResolver");
      expect(message).toContain("SecondDerivedResolver");
    });
  },
);
