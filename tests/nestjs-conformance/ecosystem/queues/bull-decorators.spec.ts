import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  Scope,
  type InjectTokenMetadata,
} from "../../../../packages/common/src";
import {
  InjectFlowProducer,
  InjectQueue,
  OnQueueEvent,
  OnWorkerEvent,
  Process,
  Processor,
  QUEUE_EVENTS_LISTENER_METADATA,
  QUEUE_EVENT_METADATA,
  QUEUE_PROCESSOR_METADATA,
  QUEUE_PROCESS_METADATA,
  QUEUE_WORKER_EVENT_METADATA,
  QUEUE_WORKER_METADATA,
  QueueEventsListener,
  getFlowProducerToken,
  getQueueToken,
  type BullMQQueueEventName,
  type NestWorkerOptions,
  type ProcessMethodMetadata,
  type ProcessorMetadata,
  type QueueEventMetadata,
  type QueueEventsListenerOptions,
  type WorkerEventMetadata,
} from "../../../../packages/queues/src";
import { describeConformance, itAdapted } from "../../_helpers/index";

const BULL_QUEUE_EVENTS = [
  "error",
  "waiting",
  "active",
  "stalled",
  "progress",
  "completed",
  "failed",
  "paused",
  "resumed",
  "cleaned",
  "drained",
  "removed",
] as const;

const BULL_QUEUE_GLOBAL_EVENTS = [
  "global:error",
  "global:waiting",
  "global:active",
  "global:stalled",
  "global:progress",
  "global:completed",
  "global:failed",
  "global:paused",
  "global:resumed",
  "global:cleaned",
  "global:drained",
  "global:removed",
] as const;

describeConformance(
  "Bull Decorators",
  {
    upstreamPath: "bull/packages/bull/lib/test/bull.decorators.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-006"],
    notes:
      "Upstream commit 2686e032f369682b4f93bdcd1cbbe2b45b34bce6. Adapts legacy @nestjs/bull decorator metadata tests to @bunest/queues (@nestjs/bullmq v12 API with ADR-006 copy-on-write class-level MetadataRegistry keys instead of legacy @OnQueueError()/@OnGlobalQueueError() shorthands or Bull v3 method-target metadata).",
  },
  () => {
    describe("@InjectQueue()", () => {
      it("should enhance class with expected constructor params metadata", () => {
        class QueueConsumer {
          constructor(
            @InjectQueue() public readonly defaultQueue: unknown,
            @InjectQueue("audio") public readonly audioQueue: unknown,
          ) {}
        }

        const tokens = MetadataRegistry.getOwn<readonly InjectTokenMetadata[]>(
          METADATA_KEYS.INJECT_TOKENS,
          QueueConsumer,
        );
        expect(tokens).toBeDefined();
        expect(tokens).toContainEqual({
          index: 0,
          token: getQueueToken(),
        });
        expect(tokens).toContainEqual({
          index: 1,
          token: getQueueToken("audio"),
        });
      });
    });

    describe("@InjectFlowProducer()", () => {
      it("should enhance class with expected flow producer constructor params metadata", () => {
        class FlowConsumer {
          constructor(
            @InjectFlowProducer() public readonly defaultFlow: unknown,
            @InjectFlowProducer("pipeline")
            public readonly namedFlow: unknown,
          ) {}
        }

        const tokens = MetadataRegistry.getOwn<readonly InjectTokenMetadata[]>(
          METADATA_KEYS.INJECT_TOKENS,
          FlowConsumer,
        );
        expect(tokens).toBeDefined();
        expect(tokens).toContainEqual({
          index: 0,
          token: getFlowProducerToken(),
        });
        expect(tokens).toContainEqual({
          index: 1,
          token: getFlowProducerToken("pipeline"),
        });
      });
    });

    describe("@Processor()", () => {
      itAdapted(
        ["ADR-006"],
        "should decorate the class with QUEUE_PROCESSOR_METADATA",
        () => {
          @Processor({})
          class MyQueue {}

          expect(Reflect.hasMetadata(QUEUE_PROCESSOR_METADATA, MyQueue)).toBe(
            true,
          );
          const meta = Reflect.getMetadata(
            QUEUE_PROCESSOR_METADATA,
            MyQueue,
          ) as ProcessorMetadata;
          expect(meta.queueName).toBe("default");
          expect(meta.name).toBeUndefined();
        },
        "@bunest/queues uses @nestjs/bullmq overloads (@Processor({}) for default queue) and QUEUE_PROCESSOR_METADATA symbol",
      );

      it("should define the QUEUE_PROCESSOR_METADATA with the given queue name", () => {
        const opts = { name: "test" };

        @Processor(opts.name)
        class MyQueue {}

        const meta = Reflect.getMetadata(
          QUEUE_PROCESSOR_METADATA,
          MyQueue,
        ) as ProcessorMetadata;
        expect(meta).toMatchObject({
          queueName: opts.name,
          name: opts.name,
        });
      });

      it("should define processor options and worker options metadata", () => {
        const workerOpts: NestWorkerOptions = { concurrency: 4 };

        @Processor(
          { name: "jobs", scope: Scope.REQUEST, configKey: "secondary" },
          workerOpts,
        )
        class ScopedQueue {}

        const procMeta = Reflect.getMetadata(
          QUEUE_PROCESSOR_METADATA,
          ScopedQueue,
        ) as ProcessorMetadata;
        const storedWorkerOpts = Reflect.getMetadata(
          QUEUE_WORKER_METADATA,
          ScopedQueue,
        ) as NestWorkerOptions;

        expect(procMeta).toMatchObject({
          queueName: "jobs",
          name: "jobs",
          scope: Scope.REQUEST,
          configKey: "secondary",
          concurrency: 4,
          workerOptions: workerOpts,
        });
        expect(storedWorkerOpts).toEqual(workerOpts);
      });
    });

    describe("@Process()", () => {
      itAdapted(
        ["ADR-006"],
        "should decorate the class with QUEUE_PROCESS_METADATA for an unnamed handler",
        () => {
          class MyQueue {
            @Process()
            prop() {}
          }

          expect(Reflect.hasMetadata(QUEUE_PROCESS_METADATA, MyQueue)).toBe(
            true,
          );
          const meta = Reflect.getMetadata(
            QUEUE_PROCESS_METADATA,
            MyQueue,
          ) as ProcessMethodMetadata[];
          expect(meta).toEqual([{ methodName: "prop", jobName: undefined }]);
        },
        "Bunest stores copy-on-write method arrays on target.constructor (ADR-006)",
      );

      itAdapted(
        ["ADR-006"],
        "should define QUEUE_PROCESS_METADATA with the given job name",
        () => {
          class MyQueue {
            @Process("test")
            prop() {}
          }

          const meta = Reflect.getMetadata(
            QUEUE_PROCESS_METADATA,
            MyQueue,
          ) as ProcessMethodMetadata[];
          expect(meta).toEqual([{ methodName: "prop", jobName: "test" }]);
        },
        "@bunest/queues @Process() accepts jobName?: string; concurrency is configured on @Processor(name, { concurrency })",
      );

      it("should keep @Process() metadata inheritance-safe across subclasses", () => {
        class BaseQueue {
          @Process("base")
          handleBase() {}
        }

        class ChildQueue extends BaseQueue {
          @Process("child")
          handleChild() {}
        }

        const baseMeta = MetadataRegistry.getOwn<ProcessMethodMetadata[]>(
          QUEUE_PROCESS_METADATA,
          BaseQueue,
        );
        const childMeta = MetadataRegistry.getOwn<ProcessMethodMetadata[]>(
          QUEUE_PROCESS_METADATA,
          ChildQueue,
        );

        expect(baseMeta).toEqual([{ methodName: "handleBase", jobName: "base" }]);
        expect(childMeta).toEqual([
          { methodName: "handleChild", jobName: "child" },
        ]);
      });
    });

    describe("@OnQueueEvent()", () => {
      it("should decorate the class with QUEUE_EVENT_METADATA and the given event name", () => {
        const eventName: BullMQQueueEventName = "completed";

        class MyQueue {
          @OnQueueEvent(eventName)
          prop() {}
        }

        expect(Reflect.hasMetadata(QUEUE_EVENT_METADATA, MyQueue)).toBe(true);
        const meta = Reflect.getMetadata(
          QUEUE_EVENT_METADATA,
          MyQueue,
        ) as QueueEventMetadata[];
        expect(meta).toEqual([
          { methodName: "prop", event: eventName, eventName },
        ]);
      });

      for (const eventName of BULL_QUEUE_EVENTS) {
        describe(`@OnQueueEvent("${eventName}") (replaces legacy @OnQueue${eventName[0]!.toUpperCase()}${eventName.slice(1)}())`, () => {
          class MyQueue {
            @OnQueueEvent(eventName)
            prop() {}
          }

          it("should decorate the class with QUEUE_EVENT_METADATA", () => {
            expect(Reflect.hasMetadata(QUEUE_EVENT_METADATA, MyQueue)).toBe(
              true,
            );
          });

          it(`should define QUEUE_EVENT_METADATA with the '${eventName}' event name`, () => {
            expect(
              Reflect.getMetadata(QUEUE_EVENT_METADATA, MyQueue),
            ).toEqual([{ methodName: "prop", event: eventName, eventName }]);
          });
        });
      }

      for (const eventName of BULL_QUEUE_GLOBAL_EVENTS) {
        describe(`@OnQueueEvent("${eventName}") (replaces legacy @OnGlobalQueue*())`, () => {
          class MyQueue {
            @OnQueueEvent(eventName)
            prop() {}
          }

          it("should decorate the class with QUEUE_EVENT_METADATA", () => {
            expect(Reflect.hasMetadata(QUEUE_EVENT_METADATA, MyQueue)).toBe(
              true,
            );
          });

          it(`should define QUEUE_EVENT_METADATA with the '${eventName}' event name`, () => {
            expect(
              Reflect.getMetadata(QUEUE_EVENT_METADATA, MyQueue),
            ).toEqual([{ methodName: "prop", event: eventName, eventName }]);
          });
        });
      }
    });

    describe("@OnWorkerEvent() & @QueueEventsListener()", () => {
      it("should define QUEUE_WORKER_EVENT_METADATA on the class", () => {
        class MyWorker {
          @OnWorkerEvent("completed")
          onCompleted() {}

          @OnWorkerEvent("failed")
          onFailed() {}
        }

        expect(Reflect.hasMetadata(QUEUE_WORKER_EVENT_METADATA, MyWorker)).toBe(
          true,
        );
        const meta = Reflect.getMetadata(
          QUEUE_WORKER_EVENT_METADATA,
          MyWorker,
        ) as WorkerEventMetadata[];
        expect(meta).toEqual([
          { methodName: "onCompleted", eventName: "completed" },
          { methodName: "onFailed", eventName: "failed" },
        ]);
      });

      it("should define QUEUE_EVENTS_LISTENER_METADATA on the class", () => {
        @QueueEventsListener("audio", { autorun: true })
        class AudioListener {}

        expect(
          Reflect.hasMetadata(QUEUE_EVENTS_LISTENER_METADATA, AudioListener),
        ).toBe(true);
        const meta = Reflect.getMetadata(
          QUEUE_EVENTS_LISTENER_METADATA,
          AudioListener,
        ) as QueueEventsListenerOptions;
        expect(meta).toEqual({
          queueName: "audio",
          queueEventsOptions: { autorun: true },
        });
      });
    });
  },
);
