import type {
  InlineWorkerPoolOptions,
  WorkerTaskContext,
  WorkerTaskHandler,
} from "./interfaces";
import { WorkerPool } from "./worker-pool";

/**
 * Generates a self-contained zero-import TypeScript worker harness for `blob:` URLs
 * so inline workers execute reliably from any working directory or bundled app
 * while speaking the exact `@bunest/jobs/workers` wire protocol.
 */
function buildSelfContainedInlineSource(fnSource: string): string {
  return `// Auto-generated Bunest inline worker harness
declare var self: Worker;
const PROTOCOL = 1;
const __userHandler = (${fnSource});
const __controllers = new Map<string, AbortController>();
const __inFlight = new Set<Promise<void>>();
let __workerId = "inline-worker";
let __initData: unknown = undefined;
let __shuttingDown = false;

function __serializeErr(err: unknown) {
  if (err instanceof Error) {
    return {
      kind: "error",
      name: err.name || "Error",
      message: err.message,
      stack: err.stack,
      ...("code" in err && typeof (err as { code?: unknown }).code === "string"
        ? { code: (err as { code: string }).code }
        : {}),
    };
  }
  return { kind: "error", name: "Error", message: String(err) };
}

self.onmessage = (event: MessageEvent) => {
  const frame = event.data;
  if (!frame || typeof frame !== "object" || frame.__bw !== PROTOCOL) return;

  if (frame.t === "init") {
    __workerId = frame.workerId || __workerId;
    __initData = frame.initData;
    self.postMessage({ __bw: PROTOCOL, t: "ready", workerId: __workerId, tasks: ["default"] });
    return;
  }

  if (frame.t === "ping") {
    self.postMessage({ __bw: PROTOCOL, t: "pong", id: frame.id });
    return;
  }

  if (frame.t === "cancel") {
    const ctrl = __controllers.get(frame.id);
    if (ctrl && !ctrl.signal.aborted) ctrl.abort(frame.reason);
    return;
  }

  if (frame.t === "shutdown") {
    if (__shuttingDown) return;
    __shuttingDown = true;
    Promise.allSettled([...__inFlight]).finally(() => {
      try {
        self.postMessage({ __bw: PROTOCOL, t: "shutdown_ack", workerId: __workerId });
      } catch {}
      try {
        if (typeof (self as { close?: () => void }).close === "function") {
          (self as { close: () => void }).close();
        }
      } catch {}
      const timer = setTimeout(() => {
        try { process.exit(0); } catch {}
      }, 25);
      (timer as { unref?: () => void }).unref?.();
    });
    return;
  }

  if (frame.t === "task" && !__shuttingDown) {
    const ctrl = new AbortController();
    __controllers.set(frame.id, ctrl);
    const ctx = {
      taskId: frame.id,
      taskName: frame.task,
      workerId: __workerId,
      signal: ctrl.signal,
      initData: __initData,
      cls: frame.cls,
      traceparent: frame.traceparent ?? frame.cls?.traceparent,
      reportProgress(progress: unknown) {
        if (!ctrl.signal.aborted && !__shuttingDown) {
          self.postMessage({ __bw: PROTOCOL, t: "progress", id: frame.id, progress });
        }
      },
    };
    const p = Promise.resolve()
      .then(() => __userHandler(frame.payload, ctx))
      .then((out) => {
        if (
          out &&
          typeof out === "object" &&
          (out as Record<PropertyKey, unknown>)[Symbol.for("bunest:workers:transferable")] === true &&
          Array.isArray((out as { transfer?: unknown }).transfer)
        ) {
          const wrapped = out as { value: unknown; transfer: Bun.Transferable[] };
          self.postMessage({ __bw: PROTOCOL, t: "result", id: frame.id, value: wrapped.value }, wrapped.transfer);
        } else {
          self.postMessage({ __bw: PROTOCOL, t: "result", id: frame.id, value: out });
        }
      })
      .catch((err) => {
        self.postMessage({ __bw: PROTOCOL, t: "error", id: frame.id, error: __serializeErr(err) });
      })
      .finally(() => {
        __controllers.delete(frame.id);
      });
    __inFlight.add(p);
    p.finally(() => __inFlight.delete(p));
  }
};
`;
}

/**
 * Creates a `WorkerPool` backed by an in-memory Bun `File` + `URL.createObjectURL()`
 * (`blob:` URL) worker without requiring a separate worker file on disk.
 *
 * The `blob:` URL is automatically revoked when `pool.close()` finishes.
 *
 * Note: Because inline functions are serialized into a separate thread, they MUST
 * be self-contained (do not capture outer main-thread closures; pass static config via `initData`).
 */
export function createInlineWorkerPool<TInput = any, TOutput = any>(
  handlerOrSource:
    | ((payload: TInput, ctx: WorkerTaskContext) => TOutput | Promise<TOutput>)
    | WorkerTaskHandler<TInput, TOutput>
    | string,
  options: InlineWorkerPoolOptions = {},
): WorkerPool {
  const { rawScript = false, filename = "inline-worker.ts", ...poolOptions } =
    options;

  const source =
    typeof handlerOrSource === "string"
      ? rawScript
        ? handlerOrSource
        : buildSelfContainedInlineSource(handlerOrSource)
      : buildSelfContainedInlineSource(handlerOrSource.toString());

  const file = new File([source], filename, {
    type: filename.endsWith(".js") || filename.endsWith(".mjs")
      ? "application/javascript"
      : "application/typescript",
  });
  const blobUrl = URL.createObjectURL(file);

  return new WorkerPool({
    ...poolOptions,
    name: poolOptions.name ?? "inline",
    script: blobUrl,
    onDispose: () => {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // Ignore if already revoked
      }
    },
  });
}
