import { describe, expect, it } from "bun:test";
import {
  BunestFactory,
  MetadataRegistry,
  Module,
  type StandardSchemaV1,
} from "@bunest/core";
import {
  MemoryQueueDriver,
  Process,
  Processor,
  QUEUE_PROCESS_METADATA,
  Queue,
  QueueModule,
  defineJobContract,
  getQueueToken,
  isJobContract,
  type JobOf,
  type ProcessMethodMetadata,
} from "../src/queues/index";

describe("Type-safe Queue Job Contracts (defineJobContract)", () => {
  const SendEmailJob = defineJobContract<
    { to: string; subject: string },
    { messageId: string }
  >("send-email", {
    defaultOptions: { attempts: 3 },
  });

  it("identifies JobContract instances and wires @Process(contract) metadata", () => {
    expect(isJobContract(SendEmailJob)).toBe(true);
    expect(isJobContract({ name: "plain" })).toBe(false);

    @Processor("emails")
    class EmailProcessor {
      @Process(SendEmailJob)
      async handle(job: JobOf<typeof SendEmailJob>) {
        return { messageId: `sent:${job.data.to}` };
      }
    }

    const meta = MetadataRegistry.get<ProcessMethodMetadata[]>(
      QUEUE_PROCESS_METADATA,
      EmailProcessor,
    );
    expect(meta).toEqual([{ methodName: "handle", jobName: "send-email" }]);
  });

  it("rejects invalid job contract names and non-contract objects in @Process()", () => {
    expect(() => defineJobContract("")).toThrow(
      "defineJobContract() requires a non-empty string job name.",
    );
    expect(() => defineJobContract("   ")).toThrow(
      "defineJobContract() requires a non-empty string job name.",
    );
    expect(() => defineJobContract("*")).toThrow(
      'defineJobContract() cannot use "*"',
    );
    expect(() => Process({ name: "plain" } as any)).toThrow(
      "@Process() expects a job name string, a JobContract",
    );
  });

  it("enqueues and processes typed jobs via queue.addContract() and queue.processContract()", async () => {
    const queue = new Queue({ name: "emails", driver: new MemoryQueueDriver() });
    let received: { to: string; subject: string } | undefined;

    queue.processContract(SendEmailJob, async (job) => {
      received = job.data;
      return { messageId: `msg:${received.to}` };
    });

    try {
      const job = await queue.addContract(SendEmailJob, {
        to: "dev@bunest.dev",
        subject: "Welcome",
      });
      expect(job.name).toBe("send-email");
      expect(job.maxAttempts).toBe(3);

      await queue.drain();
      expect(received).toEqual({ to: "dev@bunest.dev", subject: "Welcome" });
    } finally {
      await queue.close();
    }
  });

  it("merges defaultOptions cleanly (metadata deep-merge, alias overrides, undefined stripping)", async () => {
    const rawDefaults = {
      attempts: 4,
      delayMs: 5_000,
      groupId: "default-group",
      metadata: { source: "billing", version: 1 },
    };
    const InvoiceJob = defineJobContract<{ id: string }, void>(
      "invoice-send",
      { defaultOptions: rawDefaults },
    );

    // Mutating original options object must not affect frozen contract defaults
    rawDefaults.attempts = 99;
    rawDefaults.metadata.source = "mutated";

    const queue = new Queue({ name: "invoices", driver: new MemoryQueueDriver() });
    try {
      const job = await queue.addContract(
        InvoiceJob,
        { id: "inv-1" },
        {
          attempts: undefined,
          delay: 0,
          tenantId: "acme",
          metadata: { traceId: "t-123" },
        },
      );
      expect(job.maxAttempts).toBe(4);
      expect(job.status).toBe("waiting");
      expect(job.groupId).toBe("acme");
      expect(job.metadata).toEqual({
        source: "billing",
        version: 1,
        traceId: "t-123",
      });
    } finally {
      await queue.close();
    }
  });

  it("validates payload with sync, async, coerced, and empty-issues Standard Schema v1", async () => {
    const coercedSchema: StandardSchemaV1<unknown, { count: number }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        async validate(value: unknown) {
          await Promise.resolve();
          if (
            typeof value === "object" &&
            value !== null &&
            typeof (value as { count?: unknown }).count === "number" &&
            (value as { count: number }).count > 0
          ) {
            return { value: { count: (value as { count: number }).count * 2 } };
          }
          return {
            issues: [{ message: "count must be > 0", path: [{ key: "count" }] }],
          };
        },
      },
    };

    const emptyIssuesSchema: StandardSchemaV1<unknown, { ok: boolean }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate() {
          return { issues: [] };
        },
      },
    };

    const strictContract = defineJobContract<{ count: number }, void>(
      "strict-count",
      { schema: coercedSchema },
    );
    const emptyIssuesContract = defineJobContract<{ ok: boolean }, void>(
      "empty-issues",
      { schema: emptyIssuesSchema },
    );

    const queue = new Queue({ name: "strict", driver: new MemoryQueueDriver() });
    try {
      await expect(
        queue.addContract(strictContract, { count: 0 }),
      ).rejects.toThrow(
        'Invalid payload for job contract "strict-count": count: count must be > 0',
      );

      const valid = await queue.addContract(strictContract, { count: 5 });
      expect(valid.data).toEqual({ count: 10 });

      await expect(
        queue.addContract(emptyIssuesContract, { ok: true }),
      ).rejects.toThrow(
        'Invalid payload for job contract "empty-issues": Validation failed',
      );
    } finally {
      await queue.close();
    }
  });

  it("wires @Process(contract) end-to-end via QueueModule and QueueExplorer", async () => {
    const processed: Array<{ to: string; subject: string }> = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    @Processor("emails-e2e")
    class EmailWorker {
      @Process(SendEmailJob)
      async handle(job: JobOf<typeof SendEmailJob>) {
        processed.push(job.data);
        resolveDone();
        return { messageId: `e2e:${job.data.to}` };
      }
    }

    @Module({
      imports: [
        QueueModule.forRoot({ driver: new MemoryQueueDriver() }),
        QueueModule.registerQueue({ name: "emails-e2e" }),
      ],
      providers: [EmailWorker],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();
    try {
      const queue = app.get<Queue>(getQueueToken("emails-e2e"));
      const job = await queue.addContract(SendEmailJob, {
        to: "e2e@bunest.dev",
        subject: "Bootstrapped",
      });
      await done;
      await queue.drain();

      expect(processed).toEqual([
        { to: "e2e@bunest.dev", subject: "Bootstrapped" },
      ]);
      const completed = await queue.getJob(job.id);
      expect(completed?.returnValue).toEqual({
        messageId: "e2e:e2e@bunest.dev",
      });
    } finally {
      await app.close();
    }
  });
});
