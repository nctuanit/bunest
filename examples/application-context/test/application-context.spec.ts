import { describe, expect, it } from "bun:test";
import { BunestFactory, ContextIdFactory } from "@bunest/core";
import { AppModule } from "../src/app.module";
import { JobRunnerService } from "../src/context/job-runner.service";
import { LifecycleRecorderService } from "../src/lifecycle/lifecycle.service";
import {
  RequestScopedJobContext,
  TransientTokenService,
} from "../src/scopes/scoped.services";

describe("Standalone Application Context (NestJS 18-context)", () => {
  it("runs lifecycle hooks, isolates TRANSIENT & REQUEST scopes, and propagates ClsService context without HTTP", async () => {
    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    const lifecycle = ctx.get(LifecycleRecorderService);

    try {
      expect(lifecycle.events).toEqual([
        "onModuleInit",
        "onApplicationBootstrap",
      ]);

      // Transient provider creates a fresh instance on every resolve()
      const t1 = await ctx.resolve(TransientTokenService);
      const t2 = await ctx.resolve(TransientTokenService);
      expect(t1.instanceId).not.toBe(t2.instanceId);

      // Request-scoped provider is shared within the same ContextId and isolated across different ContextIds
      const reqIdA = ContextIdFactory.create();
      const reqIdB = ContextIdFactory.create();
      const reqA1 = await ctx.resolve(RequestScopedJobContext, reqIdA);
      const reqA2 = await ctx.resolve(RequestScopedJobContext, reqIdA);
      const reqB = await ctx.resolve(RequestScopedJobContext, reqIdB);

      reqA1.record("step-1");
      expect(reqA2.getSteps()).toEqual(["step-1"]);
      expect(reqA1.contextSeq).toBe(reqA2.contextSeq);
      expect(reqB.contextSeq).not.toBe(reqA1.contextSeq);
      expect(reqB.getSteps()).toEqual([]);

      // Concurrent ClsService jobs remain completely isolated across async hops
      const runner = ctx.get(JobRunnerService);
      const [acmeEntries, betaEntries] = await Promise.all([
        runner.runBatch("acme", "export", ["orders", "users"]),
        runner.runBatch("beta", "cleanup", ["sessions"]),
      ]);

      expect(acmeEntries).toEqual([
        { tenantId: "acme", jobName: "export", message: "processed:orders" },
        { tenantId: "acme", jobName: "export", message: "processed:users" },
      ]);
      expect(betaEntries).toEqual([
        { tenantId: "beta", jobName: "cleanup", message: "processed:sessions" },
      ]);
    } finally {
      await ctx.close();
    }

    expect(lifecycle.events).toEqual([
      "onModuleInit",
      "onApplicationBootstrap",
      "onModuleDestroy",
      "beforeApplicationShutdown:none",
    ]);
  });
});
