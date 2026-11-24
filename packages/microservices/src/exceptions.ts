import {
  Catch,
  IntrinsicException,
  Logger,
  type ArgumentsHost,
  type RpcExceptionFilter,
} from "@bunest/core";
import { GrpcStatus } from "./enums";
import type { GrpcMetadata } from "./grpc-metadata";

const UNKNOWN_EXCEPTION_MESSAGE = "Internal server error";

function isPlainObjectLike(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object";
}

export interface SerializedRpcError {
  readonly message: string;
  readonly name?: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly isRpcException?: boolean;
}

/**
 * Application-level RPC error propagated cleanly across microservice transports
 * without being retried as a transport fault.
 */
export class RpcException extends Error {
  private readonly errorPayload: string | Record<string, unknown>;

  constructor(error: string | object) {
    super();
    this.name = "RpcException";
    this.errorPayload = error as string | Record<string, unknown>;
    this.initMessage();
  }

  public initMessage(): void {
    if (typeof this.errorPayload === "string") {
      this.message = this.errorPayload;
    } else if (
      isPlainObjectLike(this.errorPayload) &&
      typeof this.errorPayload.message === "string"
    ) {
      this.message = this.errorPayload.message;
    } else {
      this.message = JSON.stringify(this.errorPayload);
    }
  }

  getError(): string | Record<string, unknown> | object {
    return this.errorPayload;
  }

  toSerialized(): SerializedRpcError {
    if (typeof this.errorPayload === "string") {
      return {
        message: this.errorPayload,
        name: this.name,
        isRpcException: true,
      };
    }
    return {
      message: this.message,
      name: this.name,
      status:
        typeof this.errorPayload.status === "number"
          ? this.errorPayload.status
          : undefined,
      details: this.errorPayload,
      isRpcException: true,
    };
  }

  static fromSerialized(serialized: SerializedRpcError): RpcException {
    if (
      serialized.details &&
      typeof serialized.details === "object" &&
      !Array.isArray(serialized.details)
    ) {
      return new RpcException(serialized.details as Record<string, unknown>);
    }
    return new RpcException(serialized.message || "RPC error");
  }
}

export class RpcTimeoutException extends Error {
  constructor(
    public readonly pattern: string,
    public readonly timeoutMs: number,
  ) {
    super(`RPC request "${pattern}" timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutException";
  }
}

/**
 * Transient Kafka exception that instructs `KafkaServer` to bubble the error
 * back to the consumer so the broker/client may redeliver and retry the message.
 */
export class KafkaRetriableException extends RpcException {
  public readonly isRetryable = true;

  constructor(error: string | object) {
    super(error);
    this.name = "KafkaRetriableException";
  }

  override getError(): this {
    return this;
  }
}

export interface GrpcExceptionBody {
  code: GrpcStatus;
  message: string;
}

/**
 * Structured gRPC error carrying canonical `GrpcStatus`, message, and optional
 * trailing/response `GrpcMetadata`.
 *
 * Supports both Bunest `(code, message, metadata?)` and NestJS `(message, code?, metadata?)`
 * constructor signatures seamlessly.
 */
export class GrpcException extends RpcException {
  public readonly code: GrpcStatus;
  public readonly details: string;
  public readonly metadata?: GrpcMetadata;

  constructor(code: GrpcStatus, message: string, metadata?: GrpcMetadata);
  constructor(message: string, code?: GrpcStatus, metadata?: GrpcMetadata);
  constructor(
    codeOrMessage: GrpcStatus | string,
    messageOrCode?: string | GrpcStatus,
    metadata?: GrpcMetadata,
  ) {
    const code: GrpcStatus =
      typeof codeOrMessage === "number"
        ? codeOrMessage
        : typeof messageOrCode === "number"
          ? messageOrCode
          : GrpcStatus.UNKNOWN;
    const message: string =
      typeof codeOrMessage === "string"
        ? codeOrMessage
        : typeof messageOrCode === "string"
          ? messageOrCode
          : "";

    super({
      code,
      status: code,
      message,
    });
    this.name = new.target.name || "GrpcException";
    this.code = code;
    this.details = message;
    this.metadata = metadata;
  }

  getCode(): GrpcStatus {
    return this.code;
  }

  override getError(): GrpcExceptionBody & { readonly status: GrpcStatus } {
    return {
      code: this.code,
      status: this.code,
      message: this.message,
    };
  }

  /**
   * Transient gRPC transport/deadline faults (`UNAVAILABLE`, `DEADLINE_EXCEEDED`)
   * are eligible for `ClientProxy.send(..., { retries })` automatic retries.
   */
  get isRetryable(): boolean {
    return (
      this.code === GrpcStatus.UNAVAILABLE ||
      this.code === GrpcStatus.DEADLINE_EXCEEDED
    );
  }
}

export class GrpcCancelledException extends GrpcException {
  constructor(message = "Cancelled") {
    super(message, GrpcStatus.CANCELLED);
  }
}

export class GrpcUnknownException extends GrpcException {
  constructor(message = "Unknown") {
    super(message, GrpcStatus.UNKNOWN);
  }
}

export class GrpcInvalidArgumentException extends GrpcException {
  constructor(message = "Invalid argument") {
    super(message, GrpcStatus.INVALID_ARGUMENT);
  }
}

export class GrpcDeadlineExceededException extends GrpcException {
  constructor(message = "Deadline exceeded") {
    super(message, GrpcStatus.DEADLINE_EXCEEDED);
  }
}

export class GrpcNotFoundException extends GrpcException {
  constructor(message = "Not found") {
    super(message, GrpcStatus.NOT_FOUND);
  }
}

export class GrpcAlreadyExistsException extends GrpcException {
  constructor(message = "Already exists") {
    super(message, GrpcStatus.ALREADY_EXISTS);
  }
}

export class GrpcPermissionDeniedException extends GrpcException {
  constructor(message = "Permission denied") {
    super(message, GrpcStatus.PERMISSION_DENIED);
  }
}

export class GrpcResourceExhaustedException extends GrpcException {
  constructor(message = "Resource exhausted") {
    super(message, GrpcStatus.RESOURCE_EXHAUSTED);
  }
}

export class GrpcFailedPreconditionException extends GrpcException {
  constructor(message = "Failed precondition") {
    super(message, GrpcStatus.FAILED_PRECONDITION);
  }
}

export class GrpcAbortedException extends GrpcException {
  constructor(message = "Aborted") {
    super(message, GrpcStatus.ABORTED);
  }
}

export class GrpcOutOfRangeException extends GrpcException {
  constructor(message = "Out of range") {
    super(message, GrpcStatus.OUT_OF_RANGE);
  }
}

export class GrpcUnimplementedException extends GrpcException {
  constructor(message = "Unimplemented") {
    super(message, GrpcStatus.UNIMPLEMENTED);
  }
}

export class GrpcInternalException extends GrpcException {
  constructor(message = "Internal") {
    super(message, GrpcStatus.INTERNAL);
  }
}

export class GrpcUnavailableException extends GrpcException {
  constructor(message = "Unavailable") {
    super(message, GrpcStatus.UNAVAILABLE);
  }
}

export class GrpcDataLossException extends GrpcException {
  constructor(message = "Data loss") {
    super(message, GrpcStatus.DATA_LOSS);
  }
}

export class GrpcUnauthenticatedException extends GrpcException {
  constructor(message = "Unauthenticated") {
    super(message, GrpcStatus.UNAUTHENTICATED);
  }
}

/**
 * Default Promise-based RPC exception filter (ADR-008 zero-RxJS equivalent of
 * NestJS `BaseRpcExceptionFilter`).
 */
export class BaseRpcExceptionFilter<
  T = any,
  R = any,
> implements RpcExceptionFilter<T, R> {
  protected static readonly logger = new Logger("RpcExceptionsHandler");

  catch(exception: T, _host: ArgumentsHost): Promise<R> {
    const status = "error";
    if (!(exception instanceof RpcException)) {
      return this.handleUnknownError(exception, status);
    }

    const res = exception.getError();
    if (res instanceof Error && res !== exception) {
      return this.handleUnknownError(res as unknown as T, status);
    }

    const message = isPlainObjectLike(res) ? res : { status, message: res };
    return Promise.reject(message);
  }

  handleUnknownError(exception: T, status: string): Promise<never> {
    if (!(exception instanceof IntrinsicException)) {
      BaseRpcExceptionFilter.logger.error(exception);
    }
    return Promise.reject({ status, message: UNKNOWN_EXCEPTION_MESSAGE });
  }

  isError(exception: unknown): exception is Error {
    return Boolean(isPlainObjectLike(exception) && exception.message);
  }
}

/**
 * Default Promise-based gRPC exception filter mapping `GrpcException`,
 * `RpcException`, and unknown errors into canonical `GrpcExceptionBody` payloads.
 */
@Catch()
export class GrpcExceptionFilter implements RpcExceptionFilter<unknown, never> {
  protected static readonly logger = new Logger("RpcExceptionsHandler");

  catch(exception: unknown, _host: ArgumentsHost): Promise<never> {
    if (exception instanceof GrpcException) {
      const body: GrpcExceptionBody = {
        code: exception.getCode(),
        message: exception.message,
      };
      return Promise.reject(body);
    }
    if (exception instanceof RpcException) {
      return Promise.reject(this.serializeRpcException(exception));
    }
    return Promise.reject({
      code: GrpcStatus.UNKNOWN,
      message: UNKNOWN_EXCEPTION_MESSAGE,
    } satisfies GrpcExceptionBody);
  }

  protected serializeRpcException(
    exception: RpcException,
  ): GrpcExceptionBody & Record<string, unknown> {
    const error = exception.getError();
    if (error instanceof Error && error !== exception) {
      if (!(error instanceof IntrinsicException)) {
        GrpcExceptionFilter.logger.error(error);
      }
      const code = this.getErrorCode(
        error as unknown as Record<string, unknown>,
      );
      return {
        code: typeof code === "number" ? code : GrpcStatus.UNKNOWN,
        message: UNKNOWN_EXCEPTION_MESSAGE,
      };
    }

    if (isPlainObjectLike(error)) {
      const code = this.getErrorCode(error);
      if (typeof code === "number") {
        return {
          ...error,
          code,
          message: exception.message,
        };
      }
    }

    return {
      code: GrpcStatus.UNKNOWN,
      message: exception.message,
    };
  }

  protected getErrorCode(
    error: Record<string, unknown>,
  ): GrpcStatus | undefined {
    const { code, status } = error;
    if (typeof code === "number") {
      return code as GrpcStatus;
    }
    if (typeof status === "number") {
      return status as GrpcStatus;
    }
    return undefined;
  }
}
