import {
  ClassSerializerInterceptor,
  Reflector,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/common";
import { ApplicationConfig } from "@bunest/core";
import { describe, expect, it } from "bun:test";
import { Idempotent } from "../src/decorators/idempotent.decorator";
import { IdempotencyEvents } from "../src/events/idempotency-events.service";
import { IdempotencyInterceptor } from "../src/interceptors/idempotency.interceptor";
import type { IdempotencyModuleOptions } from "../src/interfaces/idempotency-module-options.interface";
import { IdempotencyStorage } from "../src/storage/idempotency.storage";
import { InMemoryIdempotencyStore } from "../src/stores/in-memory-idempotency.store";

function createInterceptor(
  options: IdempotencyModuleOptions = {},
  store = new InMemoryIdempotencyStore(),
  appConfig?: ApplicationConfig,
) {
  const storage = new IdempotencyStorage(options);
  storage.registerSource(store);
  const events = new IdempotencyEvents();
  const reflector = new Reflector();
  const interceptor = new IdempotencyInterceptor(
    options,
    storage,
    events,
    reflector,
    undefined,
    appConfig,
  );
  return { interceptor, storage, events, store };
}

function makeGqlContext(opts: {
  cls: new (...args: any[]) => any;
  handler: Function;
  args?: Record<string, unknown>;
  headers?: Record<string, string> | Headers;
  parentTypeName?: string;
  fieldName?: string;
  pathKey?: string;
  user?: unknown;
}): ExecutionContext {
  const gqlCtx = {
    req: {
      headers: opts.headers ?? {},
      ...(opts.user !== undefined ? { user: opts.user } : {}),
    },
  };
  const info = {
    parentType: { name: opts.parentTypeName ?? "Mutation" },
    fieldName: opts.fieldName ?? opts.handler.name,
    path: { key: opts.pathKey ?? opts.fieldName ?? opts.handler.name },
    schema: {
      getMutationType: () => ({ name: "Mutation" }),
    },
  };
  const rawArgs = [null, opts.args ?? {}, gqlCtx, info];
  return {
    getType: () => "graphql" as any,
    getClass: () => opts.cls,
    getHandler: () => opts.handler,
    getArgs: () => rawArgs as any,
    getArgByIndex: <T = any>(i: number) => rawArgs[i] as T,
    switchToHttp: () => ({}) as any,
    switchToWs: () => ({}) as any,
    switchToRpc: () => ({}) as any,
  };
}

function makeRpcContext(opts: {
  cls: new (...args: any[]) => any;
  handler: Function;
  data: unknown;
  pattern?: unknown;
  rpcCtx?: Record<string, unknown>;
  arg1?: unknown;
}): ExecutionContext {
  const rpcContext = {
    getPattern: () => opts.pattern ?? "orders.created",
    ...(opts.rpcCtx ?? {}),
  };
  const rawArgs = [opts.data, opts.arg1 ?? rpcContext];
  return {
    getType: () => "rpc" as any,
    getClass: () => opts.cls,
    getHandler: () => opts.handler,
    getArgs: () => rawArgs as any,
    getArgByIndex: <T = any>(i: number) => rawArgs[i] as T,
    switchToHttp: () => ({}) as any,
    switchToWs: () => ({}) as any,
    switchToRpc: () => ({
      getData: () => opts.data as any,
      getContext: () => rpcContext as any,
    }),
  };
}

describe("GraphQL context support", () => {
  it("replays mutations by arg or Web Headers, isolates aliases, and skips queries for class-level @Idempotent()", async () => {
    @Idempotent()
    class BillingResolver {
      pay() {}
      balance() {}

      @Idempotent({ keyFrom: { arg: "input.requestId" } })
      charge() {}
    }

    const { interceptor } = createInterceptor();
    let payCalls = 0;

    // 1. Mutation with idempotencyKey arg -> executes once, replays Date & BigInt
    const date = new Date("2026-09-22T12:00:00.000Z");
    const ctx1 = makeGqlContext({
      cls: BillingResolver,
      handler: BillingResolver.prototype.pay,
      args: { idempotencyKey: "gql-1", amount: 50 },
      pathKey: "a",
    });
    const next: CallHandler = {
      handle: async () => {
        payCalls++;
        return { receipt: `r_${payCalls}`, createdAt: date, cents: 5000n };
      },
    };

    const res1 = (await interceptor.intercept(ctx1, next)) as Record<string, unknown>;
    expect(res1.receipt).toBe("r_1");
    expect(payCalls).toBe(1);

    const res2 = (await interceptor.intercept(ctx1, next)) as Record<string, unknown>;
    expect(res2.receipt).toBe("r_1");
    expect(res2.createdAt).toBeInstanceOf(Date);
    expect((res2.createdAt as Date).toISOString()).toBe(date.toISOString());
    expect(res2.cents).toBe(5000n);
    expect(payCalls).toBe(1);

    // 2. Different alias (`b` vs `a`) sharing same header key gets separate record
    const headers = new Headers({ "Idempotency-Key": "shared-hdr" });
    const aliasA = makeGqlContext({
      cls: BillingResolver,
      handler: BillingResolver.prototype.pay,
      args: { amount: 10 },
      headers,
      pathKey: "a",
    });
    const aliasB = makeGqlContext({
      cls: BillingResolver,
      handler: BillingResolver.prototype.pay,
      args: { amount: 20 },
      headers,
      pathKey: "b",
    });

    const outA = (await interceptor.intercept(aliasA, next)) as { receipt: string };
    const outB = (await interceptor.intercept(aliasB, next)) as { receipt: string };
    expect(outA.receipt).toBe("r_2");
    expect(outB.receipt).toBe("r_3");

    // 3. Reusing same alias + key with different args -> GraphQLError 422
    const mismatch = makeGqlContext({
      cls: BillingResolver,
      handler: BillingResolver.prototype.pay,
      args: { idempotencyKey: "gql-1", amount: 999 },
      pathKey: "a",
    });
    await expect(interceptor.intercept(mismatch, next)).rejects.toMatchObject({
      extensions: { code: "IDEMPOTENCY_KEY_REUSED", httpStatus: 422 },
    });

    // 4. Nested { arg: "input.requestId" } extraction
    const nestedCtx = makeGqlContext({
      cls: BillingResolver,
      handler: BillingResolver.prototype.charge,
      args: { input: { requestId: "req-99", total: 123 } },
    });
    const c1 = (await interceptor.intercept(nestedCtx, next)) as { receipt: string };
    const c2 = (await interceptor.intercept(nestedCtx, next)) as { receipt: string };
    expect(c1.receipt).toBe(c2.receipt);

    // 5. Query field is skipped by class-level @Idempotent()
    let queryCalls = 0;
    const queryCtx = makeGqlContext({
      cls: BillingResolver,
      handler: BillingResolver.prototype.balance,
      parentTypeName: "Query",
      args: { idempotencyKey: "q-1" },
    });
    const qNext: CallHandler = {
      handle: async () => ++queryCalls,
    };
    expect(await interceptor.intercept(queryCtx, qNext)).toBe(1);
    expect(await interceptor.intercept(queryCtx, qNext)).toBe(2);
  });

  it("stores deliberate GraphQL errors and releases INTERNAL_SERVER_ERROR", async () => {
    class OrdersResolver {
      @Idempotent()
      submit() {}
    }

    const { interceptor } = createInterceptor();
    const ctx = makeGqlContext({
      cls: OrdersResolver,
      handler: OrdersResolver.prototype.submit,
      args: { idempotencyKey: "gql-err-1" },
    });

    let errRuns = 0;
    const failingNext: CallHandler = {
      handle: async () => {
        errRuns++;
        const err = new Error("Invalid promo code") as Error & {
          extensions: Record<string, unknown>;
        };
        err.name = "GraphQLError";
        err.extensions = { code: "BAD_USER_INPUT" };
        throw err;
      },
    };

    await expect(interceptor.intercept(ctx, failingNext)).rejects.toThrow(
      "Invalid promo code",
    );
    await expect(interceptor.intercept(ctx, failingNext)).rejects.toThrow(
      "Invalid promo code",
    );
    expect(errRuns).toBe(1);
  });
});

describe("RPC context support", () => {
  it("deduplicates by payload.idempotencyKey, nested payload path, and transport headers per handler", async () => {
    class OrdersConsumer {
      @Idempotent()
      onCreated() {}

      @Idempotent()
      onCreatedAudit() {}

      @Idempotent({ keyFrom: { payload: "meta.eventId" } })
      onEvent() {}
    }

    const { interceptor } = createInterceptor();
    let createdCalls = 0;
    let auditCalls = 0;

    // Same key across two different handlers runs each handler independently
    const ctxCreated = makeRpcContext({
      cls: OrdersConsumer,
      handler: OrdersConsumer.prototype.onCreated,
      data: { idempotencyKey: "evt-1", orderId: 42 },
      pattern: "order.created",
    });
    const ctxAudit = makeRpcContext({
      cls: OrdersConsumer,
      handler: OrdersConsumer.prototype.onCreatedAudit,
      data: { idempotencyKey: "evt-1", orderId: 42 },
      pattern: "order.created",
    });

    const r1 = await interceptor.intercept(ctxCreated, {
      handle: async () => ({ processed: ++createdCalls }),
    });
    const r2 = await interceptor.intercept(ctxCreated, {
      handle: async () => ({ processed: ++createdCalls }),
    });
    const a1 = await interceptor.intercept(ctxAudit, {
      handle: async () => ({ audited: ++auditCalls }),
    });
    const a2 = await interceptor.intercept(ctxAudit, {
      handle: async () => ({ audited: ++auditCalls }),
    });

    expect(r1).toEqual({ processed: 1 });
    expect(r2).toEqual({ processed: 1 });
    expect(a1).toEqual({ audited: 1 });
    expect(a2).toEqual({ audited: 1 });

    // Reusing key with different payload throws RpcException (422)
    const ctxMismatch = makeRpcContext({
      cls: OrdersConsumer,
      handler: OrdersConsumer.prototype.onCreated,
      data: { idempotencyKey: "evt-1", orderId: 99 },
      pattern: "order.created",
    });
    try {
      await interceptor.intercept(ctxMismatch, {
        handle: async () => ({}),
      });
      expect.unreachable("should have rejected");
    } catch (err: any) {
      expect(typeof err.getError).toBe("function");
      expect(err.getError()).toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED",
        statusCode: 422,
      });
    }

    // Nested payload keyFrom
    let nestedCalls = 0;
    const ctxNested = makeRpcContext({
      cls: OrdersConsumer,
      handler: OrdersConsumer.prototype.onEvent,
      data: { meta: { eventId: "nested-1" }, amount: 10 },
    });
    await interceptor.intercept(ctxNested, {
      handle: async () => ++nestedCalls,
    });
    const nestedReplay = await interceptor.intercept(ctxNested, {
      handle: async () => ++nestedCalls,
    });
    expect(nestedReplay).toBe(1);
    expect(nestedCalls).toBe(1);

    // Transport header fallback (Kafka Buffer header)
    let kafkaCalls = 0;
    const ctxKafka = makeRpcContext({
      cls: OrdersConsumer,
      handler: OrdersConsumer.prototype.onCreated,
      data: { orderId: 77 },
      rpcCtx: {
        getMessage: () => ({
          headers: { "idempotency-key": Buffer.from("kafka-k1") },
        }),
      },
    });
    await interceptor.intercept(ctxKafka, {
      handle: async () => ++kafkaCalls,
    });
    expect(
      await interceptor.intercept(ctxKafka, {
        handle: async () => ++kafkaCalls,
      }),
    ).toBe(1);
    expect(kafkaCalls).toBe(1);
  });

  it("replays 4xx RpcException and releases 5xx RpcException", async () => {
    class JobsConsumer {
      @Idempotent()
      run() {}
    }

    const { interceptor } = createInterceptor();
    const makeRpcErr = (payload: Record<string, unknown>) => {
      const err = new Error(String(payload.message ?? "err")) as Error & {
        getError(): Record<string, unknown>;
      };
      err.name = "RpcException";
      err.getError = () => payload;
      return err;
    };

    let runs4xx = 0;
    const ctx4 = makeRpcContext({
      cls: JobsConsumer,
      handler: JobsConsumer.prototype.run,
      data: { idempotencyKey: "rpc-4xx" },
    });
    const next4: CallHandler = {
      handle: async () => {
        runs4xx++;
        throw makeRpcErr({ statusCode: 400, message: `bad-${runs4xx}` });
      },
    };
    await expect(interceptor.intercept(ctx4, next4)).rejects.toThrow("bad-1");
    await expect(interceptor.intercept(ctx4, next4)).rejects.toThrow("bad-1");
    expect(runs4xx).toBe(1);

    let runs5xx = 0;
    const ctx5 = makeRpcContext({
      cls: JobsConsumer,
      handler: JobsConsumer.prototype.run,
      data: { idempotencyKey: "rpc-5xx" },
    });
    const next5: CallHandler = {
      handle: async () => {
        runs5xx++;
        if (runs5xx === 1) {
          throw makeRpcErr({ statusCode: 503, message: "unavailable" });
        }
        return { ok: true, runs: runs5xx };
      },
    };
    await expect(interceptor.intercept(ctx5, next5)).rejects.toThrow(
      "unavailable",
    );
    expect(await interceptor.intercept(ctx5, next5)).toEqual({
      ok: true,
      runs: 2,
    });
  });

  it("detects ClassSerializerInterceptor registered outside IdempotencyInterceptor on bootstrap", () => {
    const appConfig = new ApplicationConfig();
    const { interceptor } = createInterceptor({}, undefined, appConfig);
    appConfig.useGlobalInterceptors(
      new ClassSerializerInterceptor(new Reflector()),
      interceptor,
    );
    expect(() => interceptor.onApplicationBootstrap()).toThrow(
      /ClassSerializerInterceptor runs outside IdempotencyInterceptor/,
    );
  });
});
