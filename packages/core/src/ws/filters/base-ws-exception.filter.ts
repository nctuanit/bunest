import {
  type ArgumentsHost,
  Catch,
  HttpException,
  Logger,
  type LoggerService,
  type WsExceptionFilter,
} from "../../common/index";
import { WsException } from "../exceptions/ws.exception";
import type { BunWsClient } from "../interfaces/ws.interface";

export interface ErrorPayload<
  Cause = {
    pattern: string;
    data?: unknown;
  },
> {
  /**
   * Error message identifier.
   */
  status: "error";
  /**
   * Error message.
   */
  message: string;
  /**
   * Message that caused the exception.
   */
  cause?: Cause;
}

export interface BaseWsExceptionFilterOptions {
  /**
   * When true, the pattern/data that caused the exception is included in the error payload.
   * @default true
   */
  includeCause?: boolean;
  /**
   * Custom factory for shaping the `cause` object attached to emitted error payloads.
   */
  causeFactory?: (pattern: string, data: unknown) => Record<string, any>;
}

type WsClientLike = {
  emit?: Function;
  send?: Function;
  readyState?: number;
};

function isLoggerService(value: unknown): value is LoggerService {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<LoggerService>).error === "function"
  );
}

function containsBinaryData(root: unknown): boolean {
  const stack: unknown[] = [root];
  const seen = new WeakSet<object>();
  let steps = 0;

  while (stack.length > 0) {
    const value = stack.pop();
    if (
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value) ||
      (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) ||
      (typeof Blob !== "undefined" && value instanceof Blob)
    ) {
      return true;
    }
    if (typeof value !== "object" || value === null) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (++steps > 10_000) {
      // Protect against pathologically deep/large payloads
      return true;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        stack.push(value[i]);
      }
    } else {
      for (const v of Object.values(value as Record<string, unknown>)) {
        stack.push(v);
      }
    }
  }
  return false;
}

function defaultCauseFactory(
  pattern: string,
  data: unknown,
): { pattern: string; data?: unknown } {
  return containsBinaryData(data) ? { pattern } : { pattern, data };
}

/**
 * Default WebSocket exception filter catching `WsException`, `HttpException`
 * (e.g. from `ValidationPipe`), and unexpected errors — emitting structured
 * `"error"` frames without crashing or tearing down the socket.
 */
@Catch()
export class BaseWsExceptionFilter<
  TError = any,
> implements WsExceptionFilter<TError> {
  protected readonly options: BaseWsExceptionFilterOptions;
  protected static readonly logger = new Logger("WsExceptionsHandler");
  private readonly logger: LoggerService;

  constructor(options?: BaseWsExceptionFilterOptions | LoggerService) {
    if (isLoggerService(options)) {
      this.logger = options;
      this.options = { includeCause: false };
    } else {
      this.logger = BaseWsExceptionFilter.logger;
      this.options = {
        includeCause: options?.includeCause ?? true,
        causeFactory: options?.causeFactory,
      };
    }
  }

  catch(exception: TError, host: ArgumentsHost, frameId?: string): void {
    const wsHost = host.switchToWs();
    const client = wsHost.getClient<BunWsClient | WsClientLike | undefined>();
    if (!client) {
      return;
    }

    let cause: ErrorPayload["cause"] | undefined;
    if (this.options.includeCause) {
      const pattern = wsHost.getPattern?.() ?? "";
      const data = wsHost.getData?.();
      cause = this.options.causeFactory
        ? (this.options.causeFactory(pattern, data) as ErrorPayload["cause"])
        : defaultCauseFactory(pattern, data);
    }

    this.handleError(client, exception, cause, frameId);
  }

  handleError<TClient extends { emit?: Function; send?: Function }>(
    client: TClient,
    exception: TError,
    cause?: ErrorPayload["cause"],
    frameId?: string,
  ): void {
    if (exception instanceof WsException) {
      const errPayload = exception.getError();
      if (errPayload instanceof Error) {
        this.handleUnknownError(
          errPayload as unknown as TError,
          client,
          cause,
          frameId,
        );
        return;
      }
      const base: Record<string, unknown> =
        typeof errPayload === "string"
          ? { status: "error", message: errPayload }
          : { status: "error", ...(errPayload as Record<string, unknown>) };
      if (cause !== undefined && !("cause" in base)) {
        base.cause = cause;
      }
      this.emitErrorPayload(client, base, frameId);
      return;
    }

    if (exception instanceof HttpException) {
      const json = exception.toJSON();
      const base: Record<string, unknown> = {
        status: "error",
        ...json,
      };
      if (cause !== undefined && !("cause" in base)) {
        base.cause = cause;
      }
      this.emitErrorPayload(client, base, frameId);
      return;
    }

    this.handleUnknownError(exception, client, cause, frameId);
  }

  handleUnknownError<TClient extends { emit?: Function; send?: Function }>(
    exception: TError,
    client: TClient,
    data?: ErrorPayload["cause"],
    frameId?: string,
  ): void {
    if (this.isExceptionObject(exception)) {
      this.logger.error(exception.message, exception.stack);
    } else {
      this.logger.error("Unhandled WebSocket exception", exception);
    }

    const payload: ErrorPayload = {
      status: "error",
      message: "Internal server error",
      ...(data !== undefined ? { cause: data } : {}),
    };
    this.emitErrorPayload(
      client,
      payload as unknown as Record<string, unknown>,
      frameId,
    );
  }

  isExceptionObject(err: unknown): err is Error {
    return (
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof (err as { message?: unknown }).message === "string"
    );
  }

  protected emitMessage<TClient extends { emit?: Function; send?: Function }>(
    client: TClient,
    event: string,
    payload: unknown,
    frameId?: string,
  ): void {
    if (this.isNativeWebSocket(client) && typeof client.send === "function") {
      const frame: Record<string, unknown> = { event, data: payload };
      if (frameId !== undefined) {
        frame.id = frameId;
      }
      client.send(JSON.stringify(frame));
      return;
    }
    if (typeof client.emit === "function") {
      client.emit(event, payload, frameId);
      return;
    }
    if (typeof client.send === "function") {
      const frame: Record<string, unknown> = { event, data: payload };
      if (frameId !== undefined) {
        frame.id = frameId;
      }
      client.send(JSON.stringify(frame));
    }
  }

  private emitErrorPayload<
    TClient extends { emit?: Function; send?: Function },
  >(client: TClient, payload: Record<string, unknown>, frameId?: string): void {
    try {
      this.emitMessage(client, "error", payload, frameId);
    } catch {
      // Retry without `cause` in case echoing the incoming payload overflows JSON serialization
      if ("cause" in payload) {
        const { cause: _dropped, ...withoutCause } = payload;
        this.emitMessage(client, "error", withoutCause, frameId);
      }
    }
  }

  private isNativeWebSocket(client: unknown): boolean {
    return (
      typeof client === "object" &&
      client !== null &&
      typeof (client as { readyState?: unknown }).readyState === "number"
    );
  }
}
