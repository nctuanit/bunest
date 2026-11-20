import "reflect-metadata";
import { beforeEach, describe, expect } from "bun:test";
import {
  Controller,
  Injectable,
  Module,
  Scope,
} from "../../../../../../packages/common/src";
import {
  GraphInspector,
  ModuleScanner,
  PartialGraphHost,
  SerializedGraph,
} from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "GraphInspector",
  {
    upstreamPath: "packages/core/test/inspector/graph-inspector.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007"],
    notes:
      "Adapted from NestJS internal InstanceWrapper/enhancersMetadataCache to @bunest/core GraphInspector API (inspectModules, insertEntrypointDefinition, insertOrphanedEnhancer, insertAttachedEnhancer, registerPartial).",
  },
  () => {
    let graph: SerializedGraph;
    let graphInspector: GraphInspector;

    beforeEach(() => {
      graph = new SerializedGraph();
      graphInspector = new GraphInspector(graph);
    });

    describe("inspectModules", () => {
      itAdapted(
        "ADR-007",
        "should inspect scanned modules, providers, controllers, and module-to-module edges",
        async () => {
          @Injectable()
          class SharedService {}

          @Module({
            providers: [SharedService],
            exports: [SharedService],
          })
          class SharedModule {}

          @Controller("items")
          class ItemsController {}

          @Injectable({ scope: Scope.TRANSIENT })
          class TransientHelper {}

          @Module({
            imports: [SharedModule],
            controllers: [ItemsController],
            providers: [TransientHelper],
          })
          class TestModule {}

          const scanned = await new ModuleScanner().scan(TestModule);
          graphInspector.inspectModules(scanned.modules);

          const json = graphInspector.getSerializedGraph().toJSON();
          const nodes = Object.values(json.nodes);
          const labels = nodes.map((n) => n.label);
          expect(labels).toContain("TestModule");
          expect(labels).toContain("SharedModule");
          expect(labels).toContain("SharedService");
          expect(labels).toContain("ItemsController");
          expect(labels).toContain("TransientHelper");

          const transientNode = nodes.find((n) => n.label === "TransientHelper");
          expect(transientNode?.metadata.transient).toBe(true);
          expect(transientNode?.metadata.static).toBe(false);

          const edges = Object.values(json.edges);
          expect(
            edges.some(
              (e) =>
                e.metadata.type === "module-to-module" &&
                e.metadata.sourceModuleName === "TestModule" &&
                e.metadata.targetModuleName === "SharedModule",
            ),
          ).toBe(true);
        },
      );
    });

    describe("insertEntrypointDefinition", () => {
      itAdapted(
        "ADR-007",
        "should insert an entrypoint definition under parentId",
        () => {
          const ep = {
            id: "ep-1",
            type: "http",
            methodName: "findAll",
            className: "UsersController",
            classNodeId: "ctrl-1",
            metadata: { path: "/users" },
          };
          graphInspector.insertEntrypointDefinition(ep, "ctrl-1");
          expect(graph.toJSON().entrypoints["ctrl-1"]).toEqual([ep]);
        },
      );
    });

    describe("insertOrphanedEnhancer", () => {
      itAdapted("ADR-007", "should add orphaned enhancer to extras", () => {
        const entry = { subtype: "guard" as const, ref: "AuthGuard" };
        graphInspector.insertOrphanedEnhancer(entry);
        expect(graph.toJSON().extras.orphanedEnhancers).toContainEqual(entry);
      });
    });

    describe("insertAttachedEnhancer", () => {
      itAdapted(
        "ADR-007",
        "should record attached enhancer nodeId in extras.attachedEnhancers",
        () => {
          graphInspector.insertAttachedEnhancer("node-enhancer-1");
          expect(graph.toJSON().extras.attachedEnhancers).toContainEqual({
            nodeId: "node-enhancer-1",
          });
        },
      );
    });

    describe("registerPartial", () => {
      itAdapted(
        "ADR-007",
        "should mark graph as partial with error cause and register with PartialGraphHost",
        () => {
          graphInspector.registerPartial(new TypeError("boom"));
          expect(graph.status).toBe("partial");
          expect(graph.metadata?.cause).toEqual({
            type: "TypeError",
            error: "boom",
          });
          expect(PartialGraphHost.toJSON().status).toBe("partial");
        },
      );
    });
  },
);
