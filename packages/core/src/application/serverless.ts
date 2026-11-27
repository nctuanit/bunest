import type { BunServerLike } from "../http/index";
import type { IEntryNestModule } from "../interfaces/core-types.interface";
import type { BunestApplication } from "./bunest-application";
import {
  BunestFactory,
  type BunestFetchHandlerOptions,
} from "./bunest-factory";

/**
 * WinterTC-compatible `{ fetch(req: Request): Promise<Response> }` handler
 * with single-flight lazy cold-start initialization and graceful teardown.
 */
export interface WinterTcFetchHandler {
  /**
   * Standard WinterTC / Bun / Edge Fetch handler entrypoint.
   * Concurrent cold-start requests share a single `BunestFactory.create()` + `init()`.
   */
  fetch(req: Request, envOrServer?: unknown, ctx?: unknown): Promise<Response>;
  /** Triggers or awaits the single-flight bootstrap and returns the ready `BunestApplication`. */
  readonly ready: () => Promise<BunestApplication>;
  /** Gracefully shuts down the lazily bootstrapped application (if initialized or in flight). */
  readonly close: (signal?: string) => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options accepted by `createBunestServer(AppModule, options)`. */
export interface BunestServerOptions extends BunestFetchHandlerOptions {
  /** Optional port exposed on the returned Bun default-export server object. */
  readonly port?: number;
  /** Optional hostname exposed on the returned Bun default-export server object. */
  readonly hostname?: string;
  /** Optional idle timeout (seconds) forwarded to Bun default-export servers. */
  readonly idleTimeout?: number;
  /** Optional development flag forwarded to Bun default-export servers. */
  readonly development?: boolean;
  /** Optional max request body size forwarded to Bun default-export servers. */
  readonly maxRequestBodySize?: number;
}

/**
 * Bun & WinterTC-compatible server export returned by `createBunestServer()`,
 * usable directly as `export default createBunestServer(AppModule, { port: 3000 })`
 * or invoked via `.fetch(req)` in serverless/edge runtimes.
 */
export interface BunestServerHandler extends WinterTcFetchHandler {
  readonly port?: number;
  readonly hostname?: string;
  readonly idleTimeout?: number;
  readonly development?: boolean;
  readonly maxRequestBodySize?: number;
}

function isBunServerLike(value: unknown): value is BunServerLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.upgrade === "function" ||
    typeof candidate.requestIP === "function" ||
    typeof candidate.stop === "function"
  );
}

/**
 * Creates a WinterTC-compatible `{ fetch(req: Request): Promise<Response> }`
 * serverless/edge adapter with single-flight cold-start initialization.
 *
 * Concurrent cold-start requests share one `BunestFactory.create()` + `configure()`
 * + `app.init()` execution without racing; if initialization fails, the next
 * request cleanly retries.
 */
export function createFetchHandler(
  rootModule: IEntryNestModule,
  options: BunestFetchHandlerOptions = {},
): WinterTcFetchHandler {
  const { configure, ...createOptions } = options;
  let appInstance: BunestApplication | undefined;
  let bootstrapPromise: Promise<BunestApplication> | undefined;
  let closingPromise: Promise<void> | undefined;

  const ensureBootstrapped = (): Promise<BunestApplication> => {
    if (appInstance) {
      return Promise.resolve(appInstance);
    }
    if (bootstrapPromise) {
      return bootstrapPromise;
    }

    let pending: Promise<BunestApplication> | undefined;
    pending = (async (): Promise<BunestApplication> => {
      let createdApp: BunestApplication | undefined;
      try {
        createdApp = await BunestFactory.create(rootModule, createOptions);
        if (configure) {
          await configure(createdApp);
        }
        await createdApp.init();
        appInstance = createdApp;
        return createdApp;
      } catch (err) {
        if (createdApp) {
          await createdApp.close().catch(() => {});
        }
        throw err;
      } finally {
        if (bootstrapPromise === pending) {
          bootstrapPromise = undefined;
        }
      }
    })();

    bootstrapPromise = pending;
    return pending;
  };

  const close = (signal?: string): Promise<void> => {
    if (closingPromise) {
      return closingPromise;
    }
    const runClose = (async (): Promise<void> => {
      const inFlight = bootstrapPromise;
      const target =
        appInstance ??
        (inFlight ? await inFlight.catch(() => undefined) : undefined);
      appInstance = undefined;
      bootstrapPromise = undefined;
      if (target) {
        await target.close(signal);
      }
    })();
    closingPromise = runClose.finally(() => {
      if (closingPromise === runClose) {
        closingPromise = undefined;
      }
    });
    return closingPromise;
  };

  return {
    async fetch(req: Request, envOrServer?: unknown): Promise<Response> {
      const app = appInstance ?? (await ensureBootstrapped());
      if (isBunServerLike(envOrServer)) {
        return app.getHttpAdapter().fetch(req, envOrServer);
      }
      return app.fetch(req);
    },
    ready: ensureBootstrapped,
    close,
    [Symbol.asyncDispose](): Promise<void> {
      return close();
    },
  };
}

/**
 * Creates a Bun & WinterTC-compatible server handler object
 * (`export default createBunestServer(AppModule, { port: 3000 })`) backed by
 * single-flight cold-start initialization.
 */
export function createBunestServer(
  rootModule: IEntryNestModule,
  options: BunestServerOptions = {},
): BunestServerHandler {
  const {
    port,
    hostname,
    idleTimeout,
    development,
    maxRequestBodySize,
    ...fetchHandlerOptions
  } = options;

  const handler = createFetchHandler(rootModule, fetchHandlerOptions);

  return {
    ...(port !== undefined ? { port } : {}),
    ...(hostname !== undefined ? { hostname } : {}),
    ...(idleTimeout !== undefined ? { idleTimeout } : {}),
    ...(development !== undefined ? { development } : {}),
    ...(maxRequestBodySize !== undefined ? { maxRequestBodySize } : {}),
    fetch: handler.fetch,
    ready: handler.ready,
    close: handler.close,
    [Symbol.asyncDispose](): Promise<void> {
      return handler.close();
    },
  };
}
