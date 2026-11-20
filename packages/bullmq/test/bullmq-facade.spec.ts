import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Injectable } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  BULL_CONFIG_DEFAULT_TOKEN,
  BullModule,
  BullRegistrar,
  FlowProducer,
  InjectFlowProducer,
  InjectQueue,
  JOB_REF,
  OnQueueEvent,
  OnWorkerEvent,
  Processor,
  ProcessorDecoratorService,
  Queue,
  QueueEventsHost,
  QueueEventsListener,
  WorkerHost,
  getFlowProducerOptionsToken,
  getFlowProducerToken,
  getQueueOptionsToken,
  getQueueToken,
  getSharedConfigToken,
  type BullRootModuleOptions,
  type Job,
  type RegisterQueueOptions,
} from "../src";

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("@bunest/bullmq drop-in facade (@nestjs/bullmq@12.0.2 41/41 parity)", () => {
  it("exports all 18 @nestjs/bullmq@12.0.2 runtime values and token helpers", () => {
    expect(BULL_CONFIG_DEFAULT_TOKEN).toBe("BULLMQ_CONFIG(default)");
    expect(JOB_REF).toBe("REQUEST");
    expect(BullModule).toBeDefined();
    expect(BullRegistrar).toBeDefined();
    expect(typeof InjectFlowProducer).toBe("function");
    expect(typeof InjectQueue).toBe("function");
    expect(typeof OnQueueEvent).toBe("function");
    expect(typeof OnWorkerEvent).toBe("function");
    expect(typeof Processor).toBe("function");
    expect(ProcessorDecoratorService).toBeDefined();
    expect(QueueEventsHost).toBeDefined();
    expect(typeof QueueEventsListener).toBe("function");
    expect(WorkerHost).toBeDefined();
    expect(getQueueToken("emails")).toBe("bunest:queues:queue:emails");
    expect(getQueueOptionsToken("emails")).toBe("BullMQQueueOptions_emails");
    expect(getFlowProducerToken("flow")).toBe("BullFlowProducer_flow");
    expect(getFlowProducerOptionsToken("flow")).toBe("BullMQFlowProducerOptions_flow");
    expect(getSharedConfigToken()).toBe(BULL_CONFIG_DEFAULT_TOKEN);
  });

  it("processes jobs end-to-end with BullModule, @Processor, WorkerHost, @OnWorkerEvent, @QueueEventsListener, and FlowProducer", async () => {
    const workerEvents: string[] = [];
    const queueEvents: string[] = [];

    @Processor("emails")
    class EmailProcessor extends WorkerHost {
      async process(job: Job<{ to: string }>): Promise<string> {
        return `sent:${job.data.to}`;
      }

      @OnWorkerEvent("completed")
      onCompleted(job: Job, result: string) {
        workerEvents.push(`${job.name}:${result}`);
      }
    }

    @QueueEventsListener("emails")
    class EmailEventsListener extends QueueEventsHost {
      @OnQueueEvent("completed")
      onCompleted(args: { jobId: string; returnvalue: string }) {
        queueEvents.push(`${args.jobId}:${args.returnvalue}`);
      }
    }

    @Injectable()
    class MailService {
      constructor(
        @InjectQueue("emails") public readonly queue: Queue<{ to: string }, string>,
        @InjectFlowProducer("mail-flow") public readonly flow: FlowProducer,
      ) {}
    }

    const rootOpts: BullRootModuleOptions = {
      prefix: "facade-bull",
      defaultJobOptions: { attempts: 1 },
    };
    const queueOpts: RegisterQueueOptions = { name: "emails" };

    const mod = await Test.createTestingModule({
      imports: [
        BullModule.forRoot(rootOpts),
        BullModule.registerQueue(queueOpts),
        BullModule.registerFlowProducer({ name: "mail-flow" }),
      ],
      providers: [EmailProcessor, EmailEventsListener, MailService],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();
    try {
      const mail = mod.get(MailService);
      expect(mail.flow).toBeInstanceOf(FlowProducer);

      const job = await mail.queue.add("welcome", { to: "ada@bunest.dev" });
      await waitUntil(() => workerEvents.length > 0 && queueEvents.length > 0);

      expect(workerEvents).toEqual(["welcome:sent:ada@bunest.dev"]);
      expect(queueEvents).toEqual([`${job.id}:sent:ada@bunest.dev`]);
    } finally {
      await app.close();
    }
  });
});
