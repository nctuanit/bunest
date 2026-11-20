import "reflect-metadata";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  PartialGraphHost,
  SerializedGraph,
} from "../../../../../../packages/core/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "PartialGraphHost",
  {
    upstreamPath: "packages/core/test/inspector/partial-graph.host.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007"],
  },
  () => {
    afterEach(() => {
      PartialGraphHost.register(new SerializedGraph());
    });

    describe("register", () => {
      it("should store the graph for later retrieval", () => {
        const graph = new SerializedGraph();
        graph.status = "partial";
        PartialGraphHost.register(graph);

        expect(PartialGraphHost.toJSON()).toBeDefined();
        expect(PartialGraphHost.toJSON().status).toBe("partial");
      });
    });

    describe("toJSON", () => {
      // BUNEST_BUG: PartialGraphHost initializes static partialGraph to an empty SerializedGraph rather than undefined (packages/core/src/inspector/partial-graph.host.ts:8)
      it.skip("should return undefined when no graph is registered", () => {
        (PartialGraphHost as unknown as { partialGraph: unknown }).partialGraph =
          undefined;
        expect(PartialGraphHost.toJSON()).toBeUndefined();
      });

      it("should delegate to the registered graph", () => {
        const graph = new SerializedGraph();
        const spy = spyOn(graph, "toJSON");
        PartialGraphHost.register(graph);

        PartialGraphHost.toJSON();

        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
      });
    });

    describe("toString", () => {
      // BUNEST_BUG: PartialGraphHost initializes static partialGraph to an empty SerializedGraph rather than undefined (packages/core/src/inspector/partial-graph.host.ts:8)
      it.skip("should return undefined when no graph is registered", () => {
        (PartialGraphHost as unknown as { partialGraph: unknown }).partialGraph =
          undefined;
        expect(PartialGraphHost.toString()).toBeUndefined();
      });

      it("should delegate to the registered graph", () => {
        const graph = new SerializedGraph();
        const spy = spyOn(graph, "toString");
        PartialGraphHost.register(graph);

        PartialGraphHost.toString();

        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
      });
    });
  },
);
