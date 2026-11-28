import { ForbiddenException } from "@bunest/core";
import { isObject } from "@bunest/core/common";
import {
  type BunHttpAdapter,
  type BunServerLike,
  normalizePath,
} from "@bunest/core/http";
import { getOperationAST, type GraphQLFormattedError, parse } from "../engine";
import type {
  GraphQLWsConnectionContext,
  GraphQLWsOptions,
  GraphQLWsSubscribeMessage,
} from "../interfaces/graphql.interface";

export const GRAPHQL_TRANSPORT_WS_PROTOCOL = "graphql-transport-ws";

export const GRAPHQL_WS_CLOSE_CODES = Object.freeze({
  BAD_REQUEST: 4400,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  CONNECTION_INIT_TIMEOUT: 4408,
  SUBSCRIBER_ALREADY_EXISTS: 4409,
  TOO_MANY_INIT_REQUESTS: 4429,
} as const);

export interface GraphQLWsExecutionOutput {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly GraphQLFormattedError[];
}

export interface GraphQLWsExecutor {
  getPath(): string;
  executeQuery(params: {
    query: string;
    variables?: Record<string, unknown> | null;
    operationName?: string | null;
    contextValue?: Record<string, unknown>;
  }): Promise<{
    status: number;
    result: GraphQLWsExecutionOutput;
  }>;
  subscribeQuery(params: {
    query: string;
    variables?: Record<string, unknown> | null;
    operationName?: string | null;
    contextValue?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<
    AsyncIterableIterator<GraphQLWsExecutionOutput> | GraphQLWsExecutionOutput
  >;
}

interface BunServerWsLike<T> {
  readonly data: T;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

interface ActiveWsSubscription {
  readonly signal: AbortSignal;
  readonly stop: () => Promise<void>;
  readonly isCancelled: () => boolean;
  readonly attachIterator: (
    iterator: AsyncIterator<GraphQLWsExecutionOutput>,
  ) => void;
}

interface GraphQLWsSocketData {
  readonly request: Request;
  initialized: boolean;
  initializing: boolean;
  closed: boolean;
  connectionParams: Record<string, unknown>;
  readonly extra: Record<string, unknown>;
  initTimer?: ReturnType<typeof setTimeout>;
  readonly subscriptions: Map<string, ActiveWsSubscription>;
  customServerClient?: unknown;
}

function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<GraphQLWsExecutionOutput> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

/**
 * Full `graphql-transport-ws` (`graphql-ws`) WebSocket subprotocol handler
 * running natively on `Bun.serve({ websocket })` via `BunHttpAdapter.registerWebsocketHandler()`.
 *
 * Implements:
 * - `connection_init` / `connection_ack` (with `onConnect` auth & timeout)
 * - `ping` / `pong`
 * - `subscribe` / `next` / `error` / `complete` (subscriptions, queries, mutations)
 * - Per-operation teardown on client `complete` and full teardown on socket `close`
 */
export class GraphQLWsHandler {
  private readonly options: GraphQLWsOptions;
  private readonly initTimeoutMs: number;
  private readonly sockets = new Set<BunServerWsLike<GraphQLWsSocketData>>();

  constructor(
    private readonly executor: GraphQLWsExecutor,
    options: GraphQLWsOptions = {},
  ) {
    this.options = options;
    this.initTimeoutMs = Math.max(
      50,
      Math.floor(options.connectionInitWaitTimeoutMs ?? 10_000),
    );
  }

  getPath(): string {
    return normalizePath(
      this.options.path ??
        this.options.server?.options?.path ??
        this.executor.getPath(),
    );
  }

  /**
   * Registers this `graphql-transport-ws` handler onto `BunHttpAdapter`.
   */
  attachToHttpAdapter(adapter: BunHttpAdapter, pathOverride?: string): void {
    const wsPath = normalizePath(pathOverride ?? this.getPath());
    adapter.registerWebsocketHandler(
      wsPath,
      (req, server) => this.handleUpgrade(req, server),
      this.createBunWebSocketConfig(),
    );
    (
      adapter as { onBeforeClose?: (fn: () => void) => void }
    ).onBeforeClose?.(() => {
      void this.closeAll();
    });
  }

  /**
   * Creates the Bun native `Bun.serve({ websocket })` handler object.
   */
  createBunWebSocketConfig(): Record<string, unknown> {
    return {
      open: (ws: BunServerWsLike<GraphQLWsSocketData>) => {
        this.handleOpen(ws);
      },
      message: (
        ws: BunServerWsLike<GraphQLWsSocketData>,
        raw: string | Uint8Array | Buffer,
      ) => {
        void this.handleMessage(ws, raw).catch(() => {
          // Prevent unhandled rejections from WebSocket message dispatch
        });
      },
      close: (
        ws: BunServerWsLike<GraphQLWsSocketData>,
        code: number,
        reason: string,
      ) => {
        void this.handleClose(ws, code, reason).catch(() => {
          // Prevent unhandled rejections from WebSocket close teardown
        });
      },
    };
  }

  /**
   * Tears down all active subscriptions and closes all connected WebSockets.
   */
  async closeAll(code = 1001, reason = "Server shutting down"): Promise<void> {
    const active = [...this.sockets];
    this.sockets.clear();
    for (const ws of active) {
      ws.data.closed = true;
      await this.cleanupSocketSubscriptions(ws.data);
      try {
        ws.close(code, reason);
      } catch {
        // Ignore already-closed sockets
      }
    }
    const customServer = this.options.server as
      | (typeof this.options.server & {
          clients?: Set<unknown>;
          listeners?: Map<string, Set<unknown>>;
          removeAllListeners?: (event?: string) => void;
          close?: () => void;
        })
      | undefined;
    if (customServer) {
      if (customServer.clients instanceof Set) {
        customServer.clients.clear();
      }
      if (typeof customServer.removeAllListeners === "function") {
        customServer.removeAllListeners("connection");
      } else if (customServer.listeners instanceof Map) {
        customServer.listeners.clear();
      }
      if (typeof customServer.close === "function") {
        try {
          customServer.close();
        } catch {
          // Ignore custom server close errors
        }
      }
    }
  }

  private handleUpgrade(
    req: Request,
    server: BunServerLike,
  ): Response | undefined {
    const protocolHeader = req.headers.get("sec-websocket-protocol");
    const requestedProtocols = protocolHeader
      ? protocolHeader
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
      : [];

    if (
      requestedProtocols.length > 0 &&
      !requestedProtocols.includes(GRAPHQL_TRANSPORT_WS_PROTOCOL)
    ) {
      return new Response("Unsupported WebSocket subprotocol", { status: 400 });
    }

    const socketData: GraphQLWsSocketData = {
      request: req,
      initialized: false,
      initializing: false,
      closed: false,
      connectionParams: {},
      extra: {},
      subscriptions: new Map(),
    };

    const headers: Record<string, string> = {};
    if (requestedProtocols.includes(GRAPHQL_TRANSPORT_WS_PROTOCOL)) {
      headers["Sec-WebSocket-Protocol"] = GRAPHQL_TRANSPORT_WS_PROTOCOL;
    }

    const upgraded =
      server.upgrade?.(req, { data: socketData, headers }) ?? false;
    if (upgraded) {
      return undefined;
    }
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  private handleOpen(ws: BunServerWsLike<GraphQLWsSocketData>): void {
    this.sockets.add(ws);
    const data = ws.data;
    if (this.options.server) {
      const customServer = this.options.server;
      customServer.handleUpgrade(
        data.request,
        ws,
        new Uint8Array(0),
        (client, req) => {
          data.customServerClient = client;
          customServer.emit("connection", client, req);
        },
      );
    }
    data.initTimer = setTimeout(() => {
      if (!data.closed && !data.initialized && !data.initializing) {
        data.closed = true;
        ws.close(
          GRAPHQL_WS_CLOSE_CODES.CONNECTION_INIT_TIMEOUT,
          "Connection initialisation timeout",
        );
      }
    }, this.initTimeoutMs);
    unrefTimer(data.initTimer);
  }

  private sendJson(
    ws: BunServerWsLike<GraphQLWsSocketData>,
    payload: Record<string, unknown>,
  ): void {
    if (ws.data.closed) {
      return;
    }
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Socket already closed
    }
  }

  private closeSocketWithProtocolError(
    ws: BunServerWsLike<GraphQLWsSocketData>,
    code: number,
    reason: string,
  ): void {
    ws.data.closed = true;
    void this.cleanupSocketSubscriptions(ws.data).catch(() => {});
    try {
      ws.close(code, reason);
    } catch {
      // Ignore already-closed socket
    }
  }

  private async handleMessage(
    ws: BunServerWsLike<GraphQLWsSocketData>,
    raw: string | Uint8Array | Buffer,
  ): Promise<void> {
    const data = ws.data;
    if (data.closed) {
      return;
    }

    const customMaxPayload = (
      this.options.server as
        | { options?: { maxPayload?: number } }
        | undefined
    )?.options?.maxPayload;
    if (typeof customMaxPayload === "number" && customMaxPayload > 0) {
      const byteLength =
        typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
      if (byteLength > customMaxPayload) {
        this.closeSocketWithProtocolError(ws, 1009, "Message too big");
        return;
      }
    }

    const text =
      typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.closeSocketWithProtocolError(
        ws,
        GRAPHQL_WS_CLOSE_CODES.BAD_REQUEST,
        "Invalid JSON message",
      );
      return;
    }

    if (!isObject(parsed) || typeof parsed.type !== "string") {
      this.closeSocketWithProtocolError(
        ws,
        GRAPHQL_WS_CLOSE_CODES.BAD_REQUEST,
        "Invalid message format",
      );
      return;
    }

    switch (parsed.type) {
      case "connection_init": {
        if (data.initialized || data.initializing) {
          this.closeSocketWithProtocolError(
            ws,
            GRAPHQL_WS_CLOSE_CODES.TOO_MANY_INIT_REQUESTS,
            "Too many initialisation requests",
          );
          return;
        }
        data.initializing = true;
        if (data.initTimer !== undefined) {
          clearTimeout(data.initTimer);
          data.initTimer = undefined;
        }

        const connectionParams = isObject(parsed.payload)
          ? { ...parsed.payload }
          : {};
        data.connectionParams = connectionParams;

        const socketHandle = {
          close: (code?: number, reason?: string) => {
            if (!data.closed) {
              this.closeSocketWithProtocolError(
                ws,
                code ?? 1000,
                reason ?? "",
              );
            }
          },
        };
        const extraWithSocket = {
          ...data.extra,
          socket: socketHandle,
          request: data.request,
        };
        const connCtx: GraphQLWsConnectionContext = {
          request: data.request,
          connectionParams,
          extra: extraWithSocket,
        };

        if (typeof this.options.onConnect === "function") {
          try {
            const decision = await this.options.onConnect(connCtx);
            if (data.closed) {
              data.initializing = false;
              return;
            }
            if (decision === false) {
              data.initializing = false;
              this.closeSocketWithProtocolError(
                ws,
                GRAPHQL_WS_CLOSE_CODES.FORBIDDEN,
                "Forbidden",
              );
              return;
            }
            if (isObject(decision)) {
              Object.assign(data.extra, decision);
            }
          } catch (err) {
            data.initializing = false;
            if (data.closed) {
              return;
            }
            const closeCode =
              err instanceof ForbiddenException
                ? GRAPHQL_WS_CLOSE_CODES.FORBIDDEN
                : 4500;
            const reason =
              err instanceof Error ? err.message : "Internal Server Error";
            this.closeSocketWithProtocolError(
              ws,
              closeCode,
              reason.slice(0, 120),
            );
            return;
          }
        }

        if (data.closed) {
          data.initializing = false;
          return;
        }

        data.initializing = false;
        data.initialized = true;
        this.sendJson(ws, { type: "connection_ack" });
        return;
      }

      case "ping": {
        this.sendJson(ws, {
          type: "pong",
          ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
        });
        return;
      }

      case "pong":
        return;

      case "subscribe": {
        if (!data.initialized) {
          this.closeSocketWithProtocolError(
            ws,
            GRAPHQL_WS_CLOSE_CODES.UNAUTHORIZED,
            "Unauthorized",
          );
          return;
        }

        const id = parsed.id;
        const payload = parsed.payload;
        if (
          typeof id !== "string" ||
          id.length === 0 ||
          !isObject(payload) ||
          typeof payload.query !== "string"
        ) {
          this.closeSocketWithProtocolError(
            ws,
            GRAPHQL_WS_CLOSE_CODES.BAD_REQUEST,
            "Invalid subscribe message",
          );
          return;
        }

        if (data.subscriptions.has(id)) {
          this.closeSocketWithProtocolError(
            ws,
            GRAPHQL_WS_CLOSE_CODES.SUBSCRIBER_ALREADY_EXISTS,
            `Subscriber for ${id} already exists`,
          );
          return;
        }

        // Reserve subscription slot SYNCHRONOUSLY before any `await` so back-to-back
        // duplicate `id` frames immediately trigger 4409 and early `complete`/socket
        // `close` cleanly cancels in-flight async `context()`/`subscribeQuery()` calls.
        const abortController = new AbortController();
        let cancelled = false;
        let activeIterator: AsyncIterator<GraphQLWsExecutionOutput> | undefined;
        let stopPromise: Promise<void> | undefined;

        const entry: ActiveWsSubscription = {
          signal: abortController.signal,
          isCancelled: () => cancelled || data.closed,
          attachIterator: (iterator) => {
            activeIterator = iterator;
          },
          stop: () => {
            if (!stopPromise) {
              cancelled = true;
              abortController.abort();
              const iter = activeIterator;
              activeIterator = undefined;
              stopPromise = (async () => {
                if (iter && typeof iter.return === "function") {
                  await iter.return().catch(() => {});
                }
              })();
            }
            return stopPromise;
          },
        };

        data.subscriptions.set(id, entry);

        let variables: Record<string, unknown> | null | undefined;
        if (isObject(payload.variables)) {
          variables = payload.variables;
        } else if (payload.variables === null) {
          variables = null;
        }

        let operationName: string | null | undefined;
        if (typeof payload.operationName === "string") {
          operationName = payload.operationName;
        } else if (payload.operationName === null) {
          operationName = null;
        }

        const subscribeMsg: GraphQLWsSubscribeMessage = {
          id,
          type: "subscribe",
          payload: {
            query: payload.query,
            variables,
            operationName,
            extensions: isObject(payload.extensions)
              ? payload.extensions
              : undefined,
          },
        };

        await this.executeWsOperation(ws, subscribeMsg, entry);
        return;
      }

      case "complete": {
        const id = parsed.id;
        if (typeof id !== "string") {
          return;
        }
        const active = data.subscriptions.get(id);
        if (active) {
          data.subscriptions.delete(id);
          await active.stop();
        }
        return;
      }

      default:
        this.closeSocketWithProtocolError(
          ws,
          GRAPHQL_WS_CLOSE_CODES.BAD_REQUEST,
          `Unknown message type "${parsed.type}"`,
        );
    }
  }

  private async executeWsOperation(
    ws: BunServerWsLike<GraphQLWsSocketData>,
    msg: GraphQLWsSubscribeMessage,
    entry: ActiveWsSubscription,
  ): Promise<void> {
    const data = ws.data;
    const { id, payload } = msg;

    const releaseSlot = (): void => {
      if (data.subscriptions.get(id) === entry) {
        data.subscriptions.delete(id);
      }
    };

    try {
      const doc = parse(payload.query);
      const opKind = getOperationAST(
        doc,
        payload.operationName ?? undefined,
      )?.operation;

      const connCtx: GraphQLWsConnectionContext = {
        request: data.request,
        connectionParams: data.connectionParams,
        extra: data.extra,
      };

      const onSubscribe = (
        this.options as {
          onSubscribe?: (
            ctx: GraphQLWsConnectionContext,
            message: GraphQLWsSubscribeMessage,
          ) => unknown;
        }
      ).onSubscribe;
      if (typeof onSubscribe === "function") {
        const subHookResult = await onSubscribe(connCtx, msg);
        if (entry.isCancelled()) {
          releaseSlot();
          return;
        }
        if (Array.isArray(subHookResult) && subHookResult.length > 0) {
          releaseSlot();
          this.sendJson(ws, {
            id,
            type: "error",
            payload: subHookResult.map((e: unknown) => {
              if (e && typeof e === "object" && "toJSON" in e) {
                return (e as { toJSON(): unknown }).toJSON();
              }
              return { message: e instanceof Error ? e.message : String(e) };
            }),
          });
          return;
        }
      }

      let customContext: Record<string, unknown> = {};
      if (typeof this.options.context === "function") {
        customContext = await this.options.context(connCtx, msg);
      } else if (
        this.options.context &&
        typeof this.options.context === "object"
      ) {
        customContext = this.options.context as Record<string, unknown>;
      }

      if (entry.isCancelled()) {
        releaseSlot();
        return;
      }

      const contextValue: Record<string, unknown> = {
        req: data.request,
        connectionParams: data.connectionParams,
        ...data.extra,
        ...customContext,
      };

      if (opKind !== "subscription") {
        const { status, result } = await this.executor.executeQuery({
          query: payload.query,
          variables: payload.variables,
          operationName: payload.operationName,
          contextValue,
        });

        releaseSlot();
        if (entry.isCancelled()) {
          return;
        }

        if (
          status >= 400 &&
          result.errors &&
          result.errors.length > 0 &&
          result.data === undefined
        ) {
          this.sendJson(ws, { id, type: "error", payload: result.errors });
          return;
        }
        this.sendJson(ws, { id, type: "next", payload: result });
        this.sendJson(ws, { id, type: "complete" });
        return;
      }

      const subOrErr = await this.executor.subscribeQuery({
        query: payload.query,
        variables: payload.variables,
        operationName: payload.operationName,
        contextValue,
        signal: entry.signal,
      });

      if (!isAsyncIterable(subOrErr)) {
        releaseSlot();
        if (entry.isCancelled()) {
          return;
        }
        this.sendJson(ws, {
          id,
          type: "error",
          payload: subOrErr.errors ?? [{ message: "Subscription failed" }],
        });
        return;
      }

      const iterator = subOrErr[Symbol.asyncIterator]();
      if (entry.isCancelled()) {
        releaseSlot();
        if (typeof iterator.return === "function") {
          await iterator.return().catch(() => {});
        }
        return;
      }

      entry.attachIterator(iterator);

      void (async () => {
        try {
          while (!entry.isCancelled()) {
            const step = await iterator.next();
            if (step.done || entry.isCancelled()) {
              break;
            }
            this.sendJson(ws, { id, type: "next", payload: step.value });
          }
          if (!entry.isCancelled() && data.subscriptions.get(id) === entry) {
            releaseSlot();
            this.sendJson(ws, { id, type: "complete" });
          }
        } catch (err) {
          const shouldSendError = !entry.isCancelled();
          releaseSlot();
          if (shouldSendError) {
            this.sendJson(ws, {
              id,
              type: "error",
              payload: [
                {
                  message: err instanceof Error ? err.message : String(err),
                },
              ],
            });
          }
        } finally {
          releaseSlot();
          await entry.stop();
        }
      })();
    } catch (err) {
      const shouldSendError = !entry.isCancelled();
      releaseSlot();
      await entry.stop();
      if (shouldSendError) {
        this.sendJson(ws, {
          id,
          type: "error",
          payload: [
            {
              message: err instanceof Error ? err.message : String(err),
            },
          ],
        });
      }
    }
  }

  private async cleanupSocketSubscriptions(
    data: GraphQLWsSocketData,
  ): Promise<void> {
    if (data.initTimer !== undefined) {
      clearTimeout(data.initTimer);
      data.initTimer = undefined;
    }
    const entries = [...data.subscriptions.values()];
    data.subscriptions.clear();
    await Promise.all(entries.map((entry) => entry.stop()));
  }

  private async handleClose(
    ws: BunServerWsLike<GraphQLWsSocketData>,
    code: number,
    reason: string,
  ): Promise<void> {
    ws.data.closed = true;
    this.sockets.delete(ws);
    await this.cleanupSocketSubscriptions(ws.data);
    if (typeof this.options.onDisconnect === "function") {
      try {
        await this.options.onDisconnect(
          {
            request: ws.data.request,
            connectionParams: ws.data.connectionParams,
            extra: ws.data.extra,
          },
          code,
          reason,
        );
      } catch {
        // Never allow disconnect hook error to crash WS close lifecycle
      }
    }
  }
}
