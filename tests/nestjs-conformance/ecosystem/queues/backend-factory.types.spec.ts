import "reflect-metadata";
import { expect, it, mock } from "bun:test";
import type {
  BullMQBackendFactory,
  BullQueueAdvancedProcessor,
  BullQueueAdvancedSeparateProcessor,
  BullRootModuleOptions,
  NestQueueEventOptions,
  NestWorkerOptions,
  RegisterFlowProducerOptions,
  RegisterQueueOptions,
} from "../../../../packages/queues/src";
import { describeConformance } from "../../_helpers/index";

/**
 * Structural equivalent of BullMQ v6's `typeof createPostgresBackend` without
 * importing the external `bullmq` package (zero external runtime dependency).
 */
type PostgresBackendFactory = (
  name: string,
  opts: Record<string, unknown>,
  options?: Record<string, unknown>,
) => unknown;

describeConformance(
  "BullMQBackendFactory",
  {
    upstreamPath:
      "bull/packages/bullmq/lib/test/backend-factory.types.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Upstream commit 2686e032f369682b4f93bdcd1cbbe2b45b34bce6. Replaces type-only `bullmq` createPostgresBackend import with a structural equivalent so type verification runs with zero external `bullmq` dependency under verbatimModuleSyntax: true.",
  },
  () => {
    it("should accept bullmq's createPostgresBackend signature in every backendFactory option", () => {
      const factory = mock(() => ({})) as unknown as PostgresBackendFactory;

      const backendFactory: BullMQBackendFactory = factory;
      const root: BullRootModuleOptions["backendFactory"] = factory;
      const queue: RegisterQueueOptions["backendFactory"] = factory;
      const flowProducer: RegisterFlowProducerOptions["backendFactory"] =
        factory;
      const processor: BullQueueAdvancedProcessor["backendFactory"] = factory;
      const separateProcessor: BullQueueAdvancedSeparateProcessor["backendFactory"] =
        factory;
      const worker: NestWorkerOptions["backendFactory"] = factory;
      const queueEvents: NestQueueEventOptions["backendFactory"] = factory;

      expect([
        backendFactory,
        root,
        queue,
        flowProducer,
        processor,
        separateProcessor,
        worker,
        queueEvents,
      ]).toEqual(Array(8).fill(factory));
    });
  },
);
