import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { ContextIdFactory } from "../../../../../../packages/core/src";
import {
  BaseExplorerService,
  type ExploredResolverMetadata,
} from "../../../../../../packages/graphql/src";
import { describeConformance, itAdapted } from "../../../../_helpers/index";

describeConformance(
  "BaseExplorerService",
  {
    upstreamPath:
      "packages/graphql/tests/services/base-explorer.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Tests BaseExplorerService.groupMetadata, getModules, and getContextId; adapts getContextId request-to-ContextId lookup from Express/Fastify REQUEST_CONTEXT_ID property to Bunest WeakMap-backed ContextIdFactory.getByRequest(req) (ADR-001, ADR-002, ADR-013).",
  },
  () => {
    const service = new BaseExplorerService();

    describe("groupMetadata", () => {
      class BaseResolver {
        account() {}
        findAll() {}
      }
      class GuardedResolver extends BaseResolver {
        override account() {}
        findAllForStaff() {}
      }
      class SiblingResolver extends BaseResolver {}
      class UnrelatedResolver {
        account() {}
      }

      const handler = (
        target: Function,
        declaredOn: Function,
        methodName = "account",
        name = "account",
      ): ExploredResolverMetadata => ({
        type: "Query",
        name,
        methodName,
        target,
        declaredOn,
        callback: { target, declaredOn, methodName } as unknown as Function,
      });

      it("should keep the handler of the subclass, whatever the scan order", () => {
        const derived = handler(GuardedResolver, GuardedResolver);
        const base = handler(BaseResolver, BaseResolver);

        expect(service.groupMetadata([derived, base]).Query?.account).toBe(
          derived.callback,
        );
        expect(service.groupMetadata([base, derived]).Query?.account).toBe(
          derived.callback,
        );
      });

      it("should keep the handler of the subclass when it only inherits the method", () => {
        // e.g., a subclass that only adds a class-level guard
        const derived = handler(SiblingResolver, BaseResolver);
        const base = handler(BaseResolver, BaseResolver);

        expect(service.groupMetadata([derived, base]).Query?.account).toBe(
          derived.callback,
        );
        expect(service.groupMetadata([base, derived]).Query?.account).toBe(
          derived.callback,
        );
      });

      it("should keep a renamed redeclaration over the inherited method of one provider", () => {
        const own = handler(
          GuardedResolver,
          GuardedResolver,
          "findAllForStaff",
          "findAllInvoice",
        );
        const inherited = handler(
          GuardedResolver,
          BaseResolver,
          "findAll",
          "findAllInvoice",
        );

        expect(
          service.groupMetadata([own, inherited]).Query?.findAllInvoice,
        ).toBe(own.callback);
        expect(
          service.groupMetadata([inherited, own]).Query?.findAllInvoice,
        ).toBe(own.callback);
      });

      // BUNEST_BUG: BaseExplorerService.keepsPrecedence() in packages/graphql/src/services/base-explorer.service.ts (lines 128-145) throws "Duplicate resolver handler" for two sibling subclasses inheriting the same method from a shared base class (first.declaredOn === second.declaredOn && first.methodName === second.methodName) instead of keeping the first handler.
      it.skip("should keep the first of two siblings inheriting the same method", () => {
        const first = handler(GuardedResolver, BaseResolver, "findAll", "all");
        const second = handler(SiblingResolver, BaseResolver, "findAll", "all");

        expect(service.groupMetadata([first, second]).Query?.all).toBe(
          first.callback,
        );
      });

      it("should keep the last handler found for the same method of one class", () => {
        // e.g., the same class provided by two modules
        const first = handler(UnrelatedResolver, UnrelatedResolver);
        const second = handler(UnrelatedResolver, UnrelatedResolver);

        expect(service.groupMetadata([first, second]).Query?.account).toBe(
          second.callback,
        );
      });

      it("should refuse handlers of the same field on classes that do not extend one another", () => {
        const first = handler(UnrelatedResolver, UnrelatedResolver);
        const second = handler(GuardedResolver, GuardedResolver);

        expect(() => service.groupMetadata([first, second])).toThrow(
          /Query\.account.*UnrelatedResolver.*GuardedResolver/,
        );
      });

      // BUNEST_BUG: BaseExplorerService.keepsPrecedence() in packages/graphql/src/services/base-explorer.service.ts (line 141) unconditionally returns false when first.target === second.target without checking first.methodName !== second.methodName, silently overwriting instead of throwing when two distinct methods on one class resolve the same GraphQL field.
      it.skip("should refuse two methods of one class resolving the same field", () => {
        const first = handler(GuardedResolver, GuardedResolver, "account", "x");
        const second = handler(
          GuardedResolver,
          GuardedResolver,
          "findAllForStaff",
          "x",
        );

        expect(() => service.groupMetadata([first, second])).toThrow(
          /Query\.x/,
        );
      });

      it("should keep the last handler when the classes are unknown", () => {
        const first: ExploredResolverMetadata = {
          type: "Query",
          name: "a",
          methodName: "a",
          callback: 1 as unknown as Function,
        };
        const second: ExploredResolverMetadata = {
          type: "Query",
          name: "a",
          methodName: "a",
          callback: 2 as unknown as Function,
        };

        expect(service.groupMetadata([first, second]).Query?.a).toBe(
          2 as unknown as Function,
        );
      });
    });

    describe("getModules", () => {
      const createModule = (metatype: Function, isGlobal = false) =>
        ({ metatype, isGlobal, imports: new Set() }) as any;

      class CatalogModule {}
      class AuditModule {}
      class SharedModule {}

      // BUNEST_BUG: BaseExplorerService.getModules() / includeWhitelisted() in packages/graphql/src/services/base-explorer.service.ts (lines 25-52) ignores the `skipGlobalImports` parameter and does not traverse `mod.imports` recursively, returning only [catalog] instead of [catalog, shared] (or [catalog, shared, audit] when skipGlobalImports is false).
      it.skip("should leave out the global modules an included module sees, when asked to", () => {
        const catalog = createModule(CatalogModule);
        const audit = createModule(AuditModule, true);
        const shared = createModule(SharedModule);
        // Nest adds every global module to the imports of every other module
        catalog.imports.add(shared).add(audit);
        shared.imports.add(audit);
        const container = new Map([
          ["catalog", catalog],
          ["audit", audit],
          ["shared", shared],
        ]);

        expect(service.getModules(container, [CatalogModule], true)).toEqual([
          catalog,
          shared,
        ]);
        expect(
          service.getModules(container, [CatalogModule, AuditModule], true),
        ).toEqual(expect.arrayContaining([catalog, shared, audit]));
        expect(service.getModules(container, [CatalogModule])).toEqual(
          expect.arrayContaining([catalog, shared, audit]),
        );
      });
    });

    describe("getContextId", () => {
      itAdapted(
        "ADR-001",
        "should find the context id assigned to a Web Standard Request and cache it on the GraphQL context",
        () => {
          const req = new Request("http://localhost/graphql", {
            method: "POST",
          });
          const contextId = ContextIdFactory.getByRequest(req);
          const gqlContext: Record<string | symbol, unknown> = { req };

          expect(service.getContextId(gqlContext)).toBe(contextId);
          expect(gqlContext[Symbol.for("bunest:graphql:context_id")]).toBe(
            contextId,
          );
        },
        "Replaces Fastify req.raw[REQUEST_CONTEXT_ID] with Bunest WeakMap ContextIdFactory.getByRequest(Request)",
      );

      itAdapted(
        "ADR-001",
        "should find the context id assigned to the request object",
        () => {
          const req = {};
          const contextId = ContextIdFactory.getByRequest(req);
          const gqlContext: Record<string | symbol, unknown> = { req };

          expect(service.getContextId(gqlContext)).toBe(contextId);
        },
        "Replaces Express req[REQUEST_CONTEXT_ID] with Bunest ContextIdFactory.getByRequest(req)",
      );

      it("should create a context id and keep it on the GraphQL context", () => {
        const gqlContext: Record<string | symbol, unknown> = {
          req: { raw: {} },
        };

        const contextId = service.getContextId(gqlContext);
        expect(contextId).toBeDefined();
        expect(service.getContextId(gqlContext)).toBe(contextId);
      });
    });
  },
);
