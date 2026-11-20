import type {
  INestApplicationContext,
  WebSocketAdapter,
  WsMessageHandler,
} from "@bunest/common";

/**
 * Minimal structural contract shared by WebSocket server and client instances
 * accepted by `AbstractWsAdapter` (matching `@nestjs/websockets` `BaseWsInstance`).
 */
export interface BaseWsInstance {
  on: (event: string, callback: Function) => void;
  close: Function;
}

function extractHttpServer(appOrHttpServer?: INestApplicationContext | object): any {
  if (!appOrHttpServer || typeof appOrHttpServer !== "object") {
    return undefined;
  }
  const candidate = appOrHttpServer as {
    getHttpServer?: () => unknown;
    getHttpAdapter?: () => unknown;
  };
  if (typeof candidate.getHttpServer === "function") {
    try {
      const srv = candidate.getHttpServer();
      if (srv !== undefined) return srv;
    } catch {
      // Server may not be listening yet; fall back to HTTP adapter
    }
  }
  if (typeof candidate.getHttpAdapter === "function") {
    return candidate.getHttpAdapter();
  }
  return appOrHttpServer;
}

/**
 * Bunest-native abstract WebSocket adapter mirroring `@nestjs/websockets`
 * `AbstractWsAdapter` with Promise-only message handling (zero RxJS per ADR-008).
 */
export abstract class AbstractWsAdapter<
  TServer extends BaseWsInstance = any,
  TClient extends BaseWsInstance = any,
  TOptions = any,
> implements WebSocketAdapter<TServer, TClient, TOptions>
{
  protected readonly httpServer: any;
  private _forceCloseConnections = false;

  set forceCloseConnections(value: boolean) {
    this._forceCloseConnections = Boolean(value);
  }

  get forceCloseConnections(): boolean {
    return this._forceCloseConnections;
  }

  constructor(appOrHttpServer?: INestApplicationContext | object) {
    this.httpServer = extractHttpServer(appOrHttpServer);
  }

  bindClientConnect(server: TServer, callback: Function): void {
    if (server && typeof server.on === "function") {
      server.on("connection", callback);
    }
  }

  bindClientDisconnect(client: TClient, callback: Function): void {
    if (client && typeof client.on === "function") {
      client.on("disconnect", callback);
    }
  }

  /**
   * Drops a client that connected before application lifecycle hooks finished.
   */
  closeClient(client: TClient): void {
    if (client && typeof client.close === "function") {
      client.close();
    }
  }

  async close(server: TServer): Promise<void> {
    if (!server || typeof server.close !== "function") {
      return;
    }
    if (server.close.length >= 1) {
      await new Promise<void>((resolve, reject) => {
        try {
          const maybePromise = server.close((err?: unknown) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
          if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
            (maybePromise as Promise<void>).then(() => resolve(), reject);
          }
        } catch (err) {
          reject(err);
        }
      });
      return;
    }
    await Promise.resolve(server.close());
  }

  async dispose(): Promise<void> {
    // Default no-op; subclasses override to release servers and registries.
  }

  abstract create(port: number, options?: TOptions): TServer;

  /**
   * Creates a non-listening server handle for standalone/microservice apps without an HTTP server.
   */
  createWithoutListener?(options?: TOptions): TServer;

  abstract bindMessageHandlers(
    client: TClient,
    handlers: WsMessageHandler[],
    transform?: (data: any) => unknown,
  ): any;
}
