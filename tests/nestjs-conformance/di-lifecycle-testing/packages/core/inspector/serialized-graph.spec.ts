import { beforeEach, describe, expect, it } from "bun:test";
import { Scope } from "../../../../../../packages/core/src/common";
import {
  SerializedGraph,
  type GraphEntrypoint,
  type GraphNodeDefinition,
} from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "SerializedGraph",
  {
    upstreamPath: "packages/core/test/inspector/serialized-graph.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007"],
  },
  () => {
    let serializedGraph: SerializedGraph;

    beforeEach(() => {
      serializedGraph = new SerializedGraph();
    });

    describe("insertNode", () => {
      it("should insert a node with the expected schema", () => {
        const nodeDefinition: GraphNodeDefinition = {
          id: "11430093-e992-4ae6-8ba4-c7db80419de8",
          label: "AppService",
          parent: "2c989d11-2731-4828-a2eb-c86d10c73621",
          metadata: {
            type: "provider",
            sourceModuleName: "AppModule",
            durable: false,
            static: true,
            transient: false,
            token: "AppService",
            scope: Scope.SINGLETON,
            exported: false,
            initTime: 100,
          },
        };
        serializedGraph.insertNode(nodeDefinition);

        expect(serializedGraph.getNodeById(nodeDefinition.id)).toBe(
          nodeDefinition,
        );
      });

      it("should return the existing node when the same id is inserted twice", () => {
        const nodeDefinition: GraphNodeDefinition = {
          id: "duplicate-id",
          label: "AppService",
          parent: "parent-id",
          metadata: {
            type: "provider",
            sourceModuleName: "AppModule",
            durable: false,
            static: true,
            transient: false,
            token: "AppService",
            scope: Scope.SINGLETON,
            exported: false,
            initTime: 100,
          },
        };

        const first = serializedGraph.insertNode(nodeDefinition);
        const second = serializedGraph.insertNode({
          ...nodeDefinition,
          label: "DifferentLabel",
        });

        expect(second).toBe(first);
        expect(serializedGraph.getNodeById("duplicate-id")?.label).toBe(
          "AppService",
        );
      });
    });

    describe("insertEdge", () => {
      it("should insert an edge with generated deterministic id and expected schema", () => {
        const edgeDefinition = {
          source: "8920252f-4e7d-4f9e-9eeb-71da467a35cc",
          target: "c97bc04d-cfcf-41b1-96ec-db729f33676e",
          metadata: {
            type: "class-to-class" as const,
            sourceModuleName: "UtilsExceptionsModule",
            sourceClassName: "AllExceptionsFilter",
            targetClassName: "AppService",
            sourceClassToken: "APP_FILTER",
            targetClassToken: "AppService",
            targetModuleName: "InternalCoreModule",
            keyOrIndex: 0,
            injectionType: "constructor" as const,
          },
        };
        const edge = serializedGraph.insertEdge(edgeDefinition);

        expect(edge.id).toBeTruthy();
        expect(serializedGraph.toJSON().edges[edge.id]).toEqual({
          ...edgeDefinition,
          id: edge.id,
        });
      });

      it("should insert a module-to-module edge", () => {
        const edge = serializedGraph.insertEdge({
          source: "mod-a",
          target: "mod-b",
          metadata: {
            type: "module-to-module",
            sourceModuleName: "ModA",
            targetModuleName: "ModB",
          },
        });

        expect(serializedGraph.toJSON().edges[edge.id]).toEqual(edge);
      });
    });

    describe("getNodeById", () => {
      it("should return a given node", () => {
        const nodeDefinition: GraphNodeDefinition = {
          id: "11430093-e992-4ae6-8ba4-c7db80419de8",
          label: "AppService",
          parent: "2c989d11-2731-4828-a2eb-c86d10c73621",
          metadata: {
            type: "provider",
            sourceModuleName: "AppModule",
            durable: false,
            static: true,
            transient: false,
            scope: Scope.SINGLETON,
            token: "AppService",
            exported: true,
            initTime: 100,
          },
        };

        serializedGraph.insertNode(nodeDefinition);
        expect(serializedGraph.getNodeById(nodeDefinition.id)).toBe(
          nodeDefinition,
        );
      });

      it("should return undefined for non-existent id", () => {
        expect(serializedGraph.getNodeById("non-existent")).toBeUndefined();
      });
    });

    describe("insertEntrypoint", () => {
      it("should create a new entrypoint collection for a parent id", () => {
        const entrypoint: GraphEntrypoint = {
          id: "ep-1",
          type: "http-endpoint",
          methodName: "findAll",
          className: "UsersController",
          classNodeId: "node-1",
          metadata: {},
        };
        serializedGraph.insertEntrypoint(entrypoint, "parent-1");

        const json = serializedGraph.toJSON();
        expect(json.entrypoints["parent-1"]).toHaveLength(1);
        expect(json.entrypoints["parent-1"]?.[0]).toBe(entrypoint);
      });

      it("should append to existing collection for the same parent id", () => {
        const ep1: GraphEntrypoint = {
          id: "ep-1",
          type: "http",
          methodName: "findAll",
          className: "UsersController",
          classNodeId: "node-1",
          metadata: {},
        };
        const ep2: GraphEntrypoint = {
          id: "ep-2",
          type: "http",
          methodName: "findOne",
          className: "UsersController",
          classNodeId: "node-1",
          metadata: {},
        };

        serializedGraph.insertEntrypoint(ep1, "parent-1");
        serializedGraph.insertEntrypoint(ep2, "parent-1");

        const json = serializedGraph.toJSON();
        expect(json.entrypoints["parent-1"]).toHaveLength(2);
      });
    });

    describe("insertOrphanedEnhancer", () => {
      it("should add an orphaned enhancer entry", () => {
        const entry = { subtype: "guard" as const, ref: "AuthGuard" };
        serializedGraph.insertOrphanedEnhancer(entry);

        const json = serializedGraph.toJSON();
        expect(json.extras.orphanedEnhancers).toContainEqual(entry);
      });
    });

    describe("insertAttachedEnhancer", () => {
      it("should add an attached enhancer with the given nodeId", () => {
        serializedGraph.insertAttachedEnhancer("node-123");

        const json = serializedGraph.toJSON();
        expect(json.extras.attachedEnhancers).toContainEqual({
          nodeId: "node-123",
        });
      });
    });

    describe("status and metadata setters", () => {
      it("should include status in JSON output", () => {
        serializedGraph.status = "partial";

        const json = serializedGraph.toJSON();
        expect(json.status).toBe("partial");
      });

      it("should default status to complete", () => {
        const json = serializedGraph.toJSON();
        expect(json.status).toBe("complete");
      });

      it("should include metadata in JSON output", () => {
        const metadata = { cause: { type: "Error", error: "failed" } };
        serializedGraph.metadata = metadata;

        const json = serializedGraph.toJSON();
        expect(json.metadata).toEqual(metadata);
      });
    });

    describe("toJSON", () => {
      it("should return a JSON representation with all collections", () => {
        const json = serializedGraph.toJSON();

        expect(json).toHaveProperty("nodes");
        expect(json).toHaveProperty("edges");
        expect(json).toHaveProperty("entrypoints");
        expect(json).toHaveProperty("extras");
      });
    });

    describe("toString", () => {
      it("should return a JSON string representation", () => {
        const result = serializedGraph.toString();
        expect(() => JSON.parse(result)).not.toThrow();
      });

      itAdapted("ADR-007", "should convert symbol values to strings", () => {
        const sym = Symbol("testSymbol");
        serializedGraph.insertEdge({
          source: "a",
          target: "b",
          metadata: {
            type: "class-to-class",
            sourceClassName: "A",
            targetClassName: "B",
            sourceModuleName: "AppModule",
            targetModuleName: "AppModule",
            injectionType: "constructor",
            targetClassToken: sym,
          },
        });

        const result = serializedGraph.toString();
        expect(result).toContain("Symbol(testSymbol)");
      });

      itAdapted(
        "ADR-007",
        "should convert function values to their names",
        () => {
          function MyService() {}
          serializedGraph.insertEdge({
            source: "a",
            target: "b",
            metadata: {
              type: "class-to-class",
              sourceClassName: "A",
              targetClassName: "B",
              sourceModuleName: "AppModule",
              targetModuleName: "AppModule",
              injectionType: "constructor",
              targetClassToken: MyService as unknown as string,
            },
          });

          const result = serializedGraph.toString();
          expect(result).toContain("MyService");
        },
      );
    });
  },
);
