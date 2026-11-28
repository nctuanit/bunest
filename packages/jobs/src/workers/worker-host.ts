import {
  BunestFactory,
  ClsService,
  DiscoveryService,
  MetadataRegistry,
  restoreClsContext,
  type BunestApplicationContext,
  type BunestCreateOptions,
  type IEntryNestModule,
} from "@bunest/core";
import { WorkerTaskNotFoundException } from "./errors";
import type {
  DefineWorkerOptions,
  WorkerHandlerMap,
  WorkerHandlerMetadata,
  WorkerTaskContext,
  WorkerTaskHandler,
} from "./interfaces";
import {
  WORKER_PROTOCOL_VERSION,
  isWorkerProtocolFrame,
  serializeWorkerError,
  unwrapTransferable,
  type MainToWorkerFrame,
  type WorkerToMainFrame,
} from "./protocol";
import { WORKER_HANDLER_METADATA } from "./tokens";
import {
  validateWithStandardSchema,
  type WorkerContract,
} from "./worker-contract";

interface WorkerGlobalScopeLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Bun.Transferable[]): void;
  close?: () => void;
}

/**
 * Returns `true` when executing on the main Bun thread (`Bun.isMainThread`).
 */
export function isMainThread(): boolean {
  return typeof Bun !== "undefined" && typeof Bun.isMainThread === "boolean"
    ? Bun.isMainThread
    : true;
}

/**
 * Returns `true` when executing inside a Bun Worker thread (`!Bun.isMainThread`).
 */
export function isWorkerThread(): boolean {
  return !isMainThread();
}

function getWorkerSelf(): WorkerGlobalScopeLike | undefined {
  if (isMainThread()) {
    return undefined;
  }
  const candidate = globalThis as unknown as Partial<WorkerGlobalScopeLike>;
  if (typeof candidate.postMessage !== "function") {
    return undefined;
  }
  return candidate as WorkerGlobalScopeLike;
}

function sendFrame(
  scope: WorkerGlobalScopeLike,
  frame: WorkerToMainFrame,
  transfer?: Bun.Transferable[],
): void {
  if (transfer && transfer.length > 0) {
    scope.postMessage(frame, transfer);
  } else {
    scope.postMessage(frame);
  }
}

export interface DefinedWorkerHandle {
  readonly handlers: ReadonlyMap<string, WorkerTaskHandler<any, any>>;
  readonly isAttached: boolean;
  /**
   * Registers an additional typed contract handler dynamically.
   */
  registerContract<TInput, TOutput>(
    contract: WorkerContract<string, TInput, TOutput>,
    handler: WorkerTaskHandler<TInput, TOutput>,
  ): this;
}

function normalizeHandlersInput(
  input: WorkerTaskHandler<any, any> | WorkerHandlerMap,
): Map<string, WorkerTaskHandler<any, any>> {
  const map = new Map<string, WorkerTaskHandler<any, any>>();
  if (typeof input === "function") {
    map.set("default", input);
    map.set("*", input);
    return map;
  }
  for (const [name, fn] of Object.entries(input)) {
    if (typeof fn === "function") {
      map.set(name, fn);
    }
  }
  return map;
}

function resolveHandler(
  handlers: ReadonlyMap<string, WorkerTaskHandler<any, any>>,
  taskName: string,
): WorkerTaskHandler<any, any> | undefined {
  return (
    handlers.get(taskName) ??
    handlers.get("*") ??
    (taskName === "default" ? handlers.get("default") : undefined)
  );
}

/**
 * Shared synchronous-attach message pump guaranteeing zero dropped messages on Bun 1.4.5.
 *
 * Per Bun's Workers contract, `self.onmessage` MUST be installed synchronously before
 * any top-level `await` — messages arriving while `readyPromise` is pending are buffered
 * and replayed in strict FIFO order once initialization completes.
 */
function attachWorkerRuntime(params: {
  readonly handlers: Map<string, WorkerTaskHandler<any, any>>;
  readonly options?: DefineWorkerOptions;
  readonly asyncSetup?: (initData: unknown) => Promise<void>;
  readonly asyncTeardown?: (reason?: string) => Promise<void>;
}): { readonly attached: boolean } {
  const scope = getWorkerSelf();
  if (!scope) {
    return { attached: false };
  }

  const clsService =
    params.options?.clsService ?? new ClsService({ generateId: false });
  const activeControllers = new Map<string, AbortController>();
  const inFlight = new Set<Promise<void>>();
  const bufferedFrames: MainToWorkerFrame[] = [];

  let workerId = "worker";
  let initData: unknown;
  let initialized = false;
  let initInProgress = false;
  let shuttingDown = false;

  const listTaskNames = (): string[] =>
    [...params.handlers.keys()].filter((name) => name !== "*");

  const finishShutdown = async (reason?: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
    try {
      await params.options?.onShutdown?.(reason);
    } catch {
      // Best-effort user shutdown hook
    }
    try {
      await params.asyncTeardown?.(reason);
    } catch {
      // Best-effort DI context teardown
    }

    try {
      sendFrame(scope, {
        __bw: WORKER_PROTOCOL_VERSION,
        t: "shutdown_ack",
        workerId,
      });
    } catch {
      // Main thread may already have closed the channel
    }

    // Prefer graceful self.close(); fallback to process.exit(0) (worker-local in Bun).
    if (typeof scope.close === "function") {
      try {
        scope.close();
      } catch {
        // Fall through to worker-local exit
      }
    }
    const timer = setTimeout(() => {
      try {
        process.exit(0);
      } catch {
        // Ignore
      }
    }, 25);
    (timer as { unref?: () => void }).unref?.();
  };

  const executeTask = async (
    frame: Extract<MainToWorkerFrame, { t: "task" }>,
  ): Promise<void> => {
    const controller = new AbortController();
    activeControllers.set(frame.id, controller);

    const ctx: WorkerTaskContext = {
      taskId: frame.id,
      taskName: frame.task,
      workerId,
      signal: controller.signal,
      initData,
      cls: frame.cls,
      traceparent: frame.traceparent ?? frame.cls?.traceparent,
      reportProgress(progress: unknown): void {
        if (controller.signal.aborted || shuttingDown) {
          return;
        }
        sendFrame(scope, {
          __bw: WORKER_PROTOCOL_VERSION,
          t: "progress",
          id: frame.id,
          progress,
        });
      },
    };

    try {
      const handler = resolveHandler(params.handlers, frame.task);
      if (!handler) {
        throw new WorkerTaskNotFoundException(frame.task, listTaskNames());
      }

      const invoke = () => Promise.resolve(handler(frame.payload, ctx));
      const rawOutput =
        frame.cls !== undefined
          ? await restoreClsContext(clsService, frame.cls, invoke)
          : await invoke();

      const { value, transfer } = unwrapTransferable(rawOutput);
      sendFrame(
        scope,
        {
          __bw: WORKER_PROTOCOL_VERSION,
          t: "result",
          id: frame.id,
          value,
        },
        transfer,
      );
    } catch (err) {
      sendFrame(scope, {
        __bw: WORKER_PROTOCOL_VERSION,
        t: "error",
        id: frame.id,
        error: serializeWorkerError(err),
      });
    } finally {
      activeControllers.delete(frame.id);
    }
  };

  const processFrame = (frame: MainToWorkerFrame): void => {
    switch (frame.t) {
      case "ping": {
        sendFrame(scope, {
          __bw: WORKER_PROTOCOL_VERSION,
          t: "pong",
          id: frame.id,
        });
        return;
      }
      case "cancel": {
        const ctrl = activeControllers.get(frame.id);
        if (ctrl && !ctrl.signal.aborted) {
          ctrl.abort(frame.reason);
        }
        return;
      }
      case "broadcast": {
        if (params.options?.onBroadcast) {
          const p = Promise.resolve(
            params.options.onBroadcast(frame.event, frame.payload),
          ).catch(() => undefined);
          inFlight.add(p);
          void p.finally(() => inFlight.delete(p));
        }
        return;
      }
      case "shutdown": {
        void finishShutdown(frame.reason);
        return;
      }
      case "task": {
        if (shuttingDown) {
          return;
        }
        const runPromise = executeTask(frame);
        inFlight.add(runPromise);
        void runPromise.finally(() => inFlight.delete(runPromise));
        return;
      }
      case "init": {
        // Duplicate init ignored after first handshake
        return;
      }
    }
  };

  const runInitSequence = async (
    frame: Extract<MainToWorkerFrame, { t: "init" }>,
  ): Promise<void> => {
    if (initInProgress || initialized) {
      return;
    }
    initInProgress = true;
    workerId = frame.workerId;
    initData = frame.initData;

    try {
      if (params.asyncSetup) {
        await params.asyncSetup(initData);
      }
      if (params.options?.onInit) {
        await params.options.onInit(initData);
      }
      initialized = true;
      sendFrame(scope, {
        __bw: WORKER_PROTOCOL_VERSION,
        t: "ready",
        workerId,
        tasks: listTaskNames(),
      });
      while (bufferedFrames.length > 0) {
        const next = bufferedFrames.shift()!;
        processFrame(next);
      }
    } catch (err) {
      sendFrame(scope, {
        __bw: WORKER_PROTOCOL_VERSION,
        t: "error",
        id: "__init__",
        error: serializeWorkerError(err),
      });
    }
  };

  // CRITICAL (Bun 1.4.5): install handler synchronously before any await!
  scope.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (!isWorkerProtocolFrame(data)) {
      return;
    }
    const frame = data as MainToWorkerFrame;
    if (frame.t === "init") {
      void runInitSequence(frame);
      return;
    }
    if (!initialized) {
      bufferedFrames.push(frame);
      return;
    }
    processFrame(frame);
  };

  return { attached: true };
}

/**
 * Mode 1 (Lightweight / Zero-DI Worker):
 * Defines a Bun Worker thread entrypoint with synchronous message registration
 * (zero startup message drops), CLS context restoration, progress reporting,
 * cancellation, `Transferable` zero-copy returns, and graceful shutdown.
 *
 * Safe to import on the main thread too (returns handle without attaching `self.onmessage`).
 */
export function defineWorker(
  handlers: WorkerTaskHandler<any, any> | WorkerHandlerMap,
  options?: DefineWorkerOptions,
): DefinedWorkerHandle {
  const handlerMap = normalizeHandlersInput(handlers);
  const { attached } = attachWorkerRuntime({
    handlers: handlerMap,
    options,
  });

  const handle: DefinedWorkerHandle = {
    handlers: handlerMap,
    isAttached: attached,
    registerContract<TInput, TOutput>(
      contract: WorkerContract<string, TInput, TOutput>,
      handler: WorkerTaskHandler<TInput, TOutput>,
    ) {
      handlerMap.set(contract.name, async (rawPayload, ctx) => {
        const validated = contract.inputSchema
          ? await validateWithStandardSchema(
              contract.name,
              contract.inputSchema,
              rawPayload,
            )
          : (rawPayload as TInput);
        return handler(validated, ctx);
      });
      return handle;
    },
  };

  return handle;
}

export interface BootstrapWorkerApplicationOptions
  extends DefineWorkerOptions,
    Omit<BunestCreateOptions, "httpAdapter"> {
  /**
   * Optional additional plain function handlers registered alongside `@WorkerHandler` providers.
   */
  readonly handlers?: WorkerHandlerMap;
}

function collectWorkerHandlerMetadata(
  target: Function,
): WorkerHandlerMetadata[] {
  const chain: Function[] = [];
  let cursor: Function | null = target;
  while (cursor && cursor !== Function.prototype && cursor !== Object) {
    chain.push(cursor);
    const parent = Object.getPrototypeOf(cursor);
    cursor = typeof parent === "function" ? parent : null;
  }
  chain.reverse();

  const merged: WorkerHandlerMetadata[] = [];
  for (const ctor of chain) {
    const own = MetadataRegistry.getOwn<readonly WorkerHandlerMetadata[]>(
      WORKER_HANDLER_METADATA,
      ctor,
    );
    if (own) {
      merged.push(...own);
    }
  }
  return merged;
}

/**
 * Mode 2 (DI-Enabled Worker):
 * Bootstraps a headless `BunestFactory.createApplicationContext(RootModule)` inside a
 * Bun Worker thread while installing `self.onmessage` synchronously before any `await`,
 * discovering every `@WorkerHandler(...)` method across the module graph.
 */
export function bootstrapWorkerApplication(
  rootModule: IEntryNestModule,
  options: BootstrapWorkerApplicationOptions = {},
): DefinedWorkerHandle {
  const {
    onInit,
    onShutdown,
    onBroadcast,
    clsService,
    handlers: extraHandlers,
    ...createOptions
  } = options;

  const handlerMap = extraHandlers
    ? normalizeHandlersInput(extraHandlers)
    : new Map<string, WorkerTaskHandler<any, any>>();

  let appContext: BunestApplicationContext | undefined;

  const { attached } = attachWorkerRuntime({
    handlers: handlerMap,
    options: { onInit, onShutdown, onBroadcast, clsService },
    asyncSetup: async () => {
      appContext = await BunestFactory.createApplicationContext(rootModule, {
        logger: false,
        ...createOptions,
      });
      await appContext.init();

      const discovery = appContext.get(DiscoveryService, { strict: false });
      const wrappers = discovery ? discovery.getProviders() : [];

      for (const wrapper of wrappers) {
        const instance = wrapper.instance;
        if (!instance || typeof instance !== "object") continue;
        const ctor = (instance as { constructor?: Function }).constructor;
        if (typeof ctor !== "function") continue;

        const metas = collectWorkerHandlerMetadata(ctor);
        for (const meta of metas) {
          const fn = (instance as Record<string | symbol, unknown>)[
            meta.methodName
          ];
          if (typeof fn !== "function") continue;

          handlerMap.set(meta.taskName, async (rawPayload, ctx) => {
            const payload = meta.contract?.inputSchema
              ? await validateWithStandardSchema(
                  meta.taskName,
                  meta.contract.inputSchema,
                  rawPayload,
                )
              : rawPayload;
            return await (fn as WorkerTaskHandler).call(instance, payload, ctx);
          });
        }
      }
    },
    asyncTeardown: async () => {
      if (appContext) {
        const ctxToClose = appContext;
        appContext = undefined;
        await ctxToClose.close();
      }
    },
  });

  const handle: DefinedWorkerHandle = {
    handlers: handlerMap,
    isAttached: attached,
    registerContract<TInput, TOutput>(
      contract: WorkerContract<string, TInput, TOutput>,
      handler: WorkerTaskHandler<TInput, TOutput>,
    ) {
      handlerMap.set(contract.name, async (rawPayload, ctx) => {
        const validated = contract.inputSchema
          ? await validateWithStandardSchema(
              contract.name,
              contract.inputSchema,
              rawPayload,
            )
          : (rawPayload as TInput);
        return handler(validated, ctx);
      });
      return handle;
    },
  };

  return handle;
}
