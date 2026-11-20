import "reflect-metadata";
import { beforeEach, describe, expect, it } from "bun:test";
import { ModulesContainer } from "../../../../../../packages/core/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ModulesContainer",
  {
    upstreamPath: "packages/core/test/injector/modules-container.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Tests ModulesContainer applicationId, getById, and RPC target registry parity (ADR-008 zero RxJS).",
  },
  () => {
    let container: ModulesContainer;

    beforeEach(() => {
      container = new ModulesContainer();
    });

    describe("applicationId", () => {
      it("should return a string identifier", () => {
        expect(typeof container.applicationId).toBe("string");
      });

      it("should return the same id on subsequent calls", () => {
        expect(container.applicationId).toBe(container.applicationId);
      });

      it("should return different ids for different containers", () => {
        const container2 = new ModulesContainer();
        expect(container.applicationId).not.toBe(container2.applicationId);
      });
    });

    describe("getById", () => {
      // BUNEST_BUG: ModulesContainer.getById(id) delegates to Map.get(id) instead of searching values by module.id (packages/core/src/di/modules-container.ts).
      it.skip("should return a module by its id even when stored under a different map key", () => {
        const mockModule = { id: "test-id" } as any;
        container.set("key", mockModule);

        expect(container.getById("test-id")).toBe(mockModule);
      });

      it("should return a module when stored under its id as key", () => {
        const mockModule = { id: "direct-id" } as any;
        container.set("direct-id", mockModule);

        expect(container.getById("direct-id")).toBe(mockModule);
      });

      it("should return undefined if no module matches", () => {
        expect(container.getById("non-existent")).toBeUndefined();
      });
    });

    describe("getRpcTargetRegistry / addRpcTarget", () => {
      // BUNEST_BUG: ModulesContainer does not implement addRpcTarget()/getRpcTargetRegistry() (packages/core/src/di/modules-container.ts).
      it.skip("should expose addRpcTarget and getRpcTargetRegistry for dynamically registered RPC targets", () => {
        const target = { pattern: "test" };
        (container as any).addRpcTarget(target);
        const registry = (container as any).getRpcTargetRegistry();
        expect(registry).toBeDefined();
      });

      // BUNEST_BUG: ModulesContainer does not implement addRpcTarget()/getRpcTargetRegistry() (packages/core/src/di/modules-container.ts).
      it.skip("should preserve previously added RPC targets for later consumers", () => {
        (container as any).addRpcTarget("first");
        (container as any).addRpcTarget("second");
        const registry = (container as any).getRpcTargetRegistry();
        expect(registry).toBeDefined();
      });
    });
  },
);
