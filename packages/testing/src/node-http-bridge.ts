import type { FetchCapable } from "./interfaces/testing.interface";

export interface BridgeAddressInfo {
  readonly address: string;
  readonly family: "IPv4" | "IPv6";
  readonly port: number;
}

export interface BridgeListenOptions {
  port?: number;
  host?: string;
  hostname?: string;
  backlog?: number;
}

type EventListener = (...args: unknown[]) => void;

/**
 * Structural Node `http.Server`-compatible handle backed directly by Bun native `Bun.serve()`.
 */
export interface NodeHttpBridgeServer {
  readonly listening: boolean;
  readonly url: URL | undefined;
  listen(
    port?: number | BridgeListenOptions | (() => void),
    hostnameOrCallback?: string | (() => void),
    backlogOrCallback?: number | (() => void),
    callback?: () => void,
  ): this;
  address(): BridgeAddressInfo | null;
  close(callback?: (err?: Error) => void): this;
  closeAllConnections(): void;
  closeIdleConnections(): void;
  ref(): this;
  unref(): this;
  on(event: string, listener: EventListener): this;
  once(event: string, listener: EventListener): this;
  off(event: string, listener: EventListener): this;
  addListener(event: string, listener: EventListener): this;
  removeListener(event: string, listener: EventListener): this;
  emit(event: string, ...args: unknown[]): boolean;
}

function parseListenArgs(
  portOrOpts?: number | BridgeListenOptions | (() => void),
  hostnameOrCallback?: string | (() => void),
  backlogOrCallback?: number | (() => void),
  callback?: () => void,
): { port: number; hostname: string; cb?: () => void } {
  let port = 0;
  let hostname = "127.0.0.1";
  let cb: (() => void) | undefined;

  if (typeof portOrOpts === "function") {
    cb = portOrOpts;
  } else if (typeof portOrOpts === "object" && portOrOpts !== null) {
    port = portOrOpts.port ?? 0;
    hostname = portOrOpts.hostname ?? portOrOpts.host ?? "127.0.0.1";
    if (typeof hostnameOrCallback === "function") {
      cb = hostnameOrCallback;
    }
  } else {
    if (typeof portOrOpts === "number") {
      port = portOrOpts;
    }
    if (typeof hostnameOrCallback === "string") {
      hostname = hostnameOrCallback;
      if (typeof backlogOrCallback === "function") {
        cb = backlogOrCallback;
      } else if (typeof callback === "function") {
        cb = callback;
      }
    } else if (typeof hostnameOrCallback === "function") {
      cb = hostnameOrCallback;
    }
  }

  return { port, hostname, cb };
}

class BunHttpBridgeServer implements NodeHttpBridgeServer {
  private server: ReturnType<typeof Bun.serve> | undefined;
  private boundHost = "127.0.0.1";
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(private readonly app: FetchCapable) {}

  get listening(): boolean {
    return this.server !== undefined;
  }

  get url(): URL | undefined {
    return this.server?.url;
  }

  listen(
    portOrOpts?: number | BridgeListenOptions | (() => void),
    hostnameOrCallback?: string | (() => void),
    backlogOrCallback?: number | (() => void),
    callback?: () => void,
  ): this {
    const { port, hostname, cb } = parseListenArgs(
      portOrOpts,
      hostnameOrCallback,
      backlogOrCallback,
      callback,
    );

    if (cb) {
      this.once("listening", cb);
    }

    if (this.server) {
      queueMicrotask(() => this.emit("listening"));
      return this;
    }

    const app = this.app;
    this.boundHost = hostname;

    try {
      this.server = Bun.serve({
        hostname,
        port,
        async fetch(req: Request): Promise<Response> {
          try {
            return await app.fetch(req);
          } catch (error: unknown) {
            return new Response(
              JSON.stringify({
                statusCode: 500,
                error: "Internal Server Error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Internal server error",
              }),
              {
                status: 500,
                headers: {
                  "content-type": "application/json; charset=utf-8",
                },
              },
            );
          }
        },
      });
      queueMicrotask(() => this.emit("listening"));
    } catch (err) {
      queueMicrotask(() => this.emit("error", err));
    }

    return this;
  }

  address(): BridgeAddressInfo | null {
    if (!this.server) {
      return null;
    }
    const addr = this.server.hostname ?? this.boundHost;
    return {
      address: addr,
      family: addr.includes(":") ? "IPv6" : "IPv4",
      port: this.server.port ?? 0,
    };
  }

  close(callback?: (err?: Error) => void): this {
    const active = this.server;
    this.server = undefined;
    if (!active) {
      queueMicrotask(() => {
        callback?.();
        this.emit("close");
      });
      return this;
    }
    Promise.resolve(active.stop(true)).then(
      () => {
        callback?.();
        this.emit("close");
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        callback?.(error);
        this.emit("error", error);
      },
    );
    return this;
  }

  closeAllConnections(): void {
    if (this.server) {
      void this.server.stop(true);
      this.server = undefined;
    }
  }

  closeIdleConnections(): void {
    // Bun.serve manages idle keep-alive sockets internally.
  }

  ref(): this {
    this.server?.ref();
    return this;
  }

  unref(): this {
    this.server?.unref();
    return this;
  }

  on(event: string, listener: EventListener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  addListener(event: string, listener: EventListener): this {
    return this.on(event, listener);
  }

  once(event: string, listener: EventListener): this {
    const wrapped: EventListener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: EventListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: EventListener): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return false;
    }
    for (const listener of [...set]) {
      listener(...args);
    }
    return true;
  }
}

/**
 * Bun-native HTTP bridge server (`Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })`)
 * exposing a Node `http.Server`-compatible `.listen()` / `.address()` / `.close()` contract
 * with zero `node:http` dependency.
 *
 * Allows passing any Bunest `BunestApplication` / `FetchCapable` to tools expecting a
 * Node `http.Server`-like handle (such as `createNodeHttpServer(app)`).
 * Faithfully forwards binary payloads, streams, and multiple `Set-Cookie` headers directly
 * through Bun's native HTTP server.
 */
export function createNodeHttpServer(app: FetchCapable): NodeHttpBridgeServer {
  return new BunHttpBridgeServer(app);
}
