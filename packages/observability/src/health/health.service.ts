import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type BeforeApplicationShutdown,
  type HttpExceptionResponse,
  type LoggerService,
} from "@bunest/core";
import {
  HealthCheckAttempt,
  type HealthIndicatorFunction,
  type InferHealthIndicatorResults,
} from "./health-indicator.service";
import {
  HealthCheckStatus,
  HealthIndicatorStatus,
  TERMINUS_LOGGER,
  TERMINUS_MODULE_OPTIONS,
  type HealthCheckOptions,
  type HealthCheckResult,
  type HealthIndicatorResult,
  type TerminusAsyncModuleOptions,
} from "./health.interface";
import { TimeoutError, formatErrorMessage } from "./units";

export class HealthCheckException extends ServiceUnavailableException {
  public readonly result: HealthCheckResult;

  constructor(result: HealthCheckResult) {
    super({
      message: "Health check failed",
      status: result.status,
      info: result.info,
      error: result.error,
      errors: result.error,
      details: result.details,
      timestamp: result.timestamp,
    });
    this.result = result;
  }

  override toJSON(): HttpExceptionResponse {
    return {
      status: this.result.status,
      info: this.result.info,
      error: this.result.error,
      details: this.result.details,
    } as unknown as HttpExceptionResponse;
  }
}

/**
 * Terminus-compatible health check error (subclass of `HealthCheckException`).
 * Accepts either a `HealthCheckResult` or `(message, causes)` like `@nestjs/terminus`.
 */
export class HealthCheckError extends HealthCheckException {
  public readonly causes: unknown;

  constructor(messageOrResult: string | HealthCheckResult, causes?: unknown) {
    if (typeof messageOrResult === "string") {
      const normalizedDetails: HealthIndicatorResult =
        causes && typeof causes === "object" && !Array.isArray(causes)
          ? (causes as HealthIndicatorResult)
          : {
              health: {
                status: HealthIndicatorStatus.DOWN,
                message: messageOrResult,
              },
            };
      const result: HealthCheckResult = {
        status: HealthCheckStatus.ERROR,
        info: {},
        error: normalizedDetails,
        details: normalizedDetails,
        timestamp: new Date().toISOString(),
      };
      super(result);
      this.message = messageOrResult;
      this.causes = causes;
    } else {
      super(messageOrResult);
      this.causes = causes ?? messageOrResult.error;
    }
    this.name = "HealthCheckError";
  }
}

async function runIndicatorWithTimeout(
  indicator: HealthIndicatorFunction,
  index: number,
  timeoutMs: number | undefined,
): Promise<HealthIndicatorResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const effectiveTimeout = timeoutMs;

  const invoke = (): Promise<HealthIndicatorResult> => {
    if (indicator instanceof HealthCheckAttempt) {
      return Promise.resolve(indicator as PromiseLike<HealthIndicatorResult>);
    }
    return Promise.resolve().then(
      () =>
        indicator() as
          PromiseLike<HealthIndicatorResult> | HealthIndicatorResult,
    );
  };

  if (effectiveTimeout === undefined) {
    try {
      return await invoke();
    } catch (err) {
      return {
        [`indicator_${index}`]: {
          status: HealthIndicatorStatus.DOWN,
          message: formatErrorMessage(err),
        },
      };
    }
  }

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new TimeoutError(
          `Health indicator #${index} timed out after ${effectiveTimeout}ms`,
        ),
      );
    }, effectiveTimeout);
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
  });

  try {
    return await Promise.race([invoke(), timeoutPromise]);
  } catch (err) {
    return {
      [`indicator_${index}`]: {
        status: HealthIndicatorStatus.DOWN,
        message: formatErrorMessage(err),
      },
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function stringifyWithSymbols(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "symbol" ? val.toString() : val,
  );
}

function formatErrorLog(
  style: "pretty" | "json",
  details: HealthIndicatorResult,
): string {
  if (style === "pretty") {
    const lines = ["Health Check has failed!"];
    for (const [key, value] of Object.entries(details)) {
      lines.push(`  - ${key}: ${stringifyWithSymbols(value)}`);
    }
    return lines.join("\n");
  }
  return `Health Check has failed! ${stringifyWithSymbols(details)}`;
}

/**
 * Terminus v12-compatible health check orchestrator executing indicators in parallel.
 * - Supports `HealthCheckAttempt`, `HealthIndicatorResult`, `"up"`, `"degraded"` (HTTP 200),
 *   `"down"` (HTTP 503), and `"shutting_down"` (HTTP 503 during graceful shutdown).
 */
@Injectable()
export class HealthCheckService implements BeforeApplicationShutdown {
  private isShuttingDown = false;

  constructor(
    @Optional()
    @Inject(TERMINUS_MODULE_OPTIONS)
    private readonly terminusOptions: TerminusAsyncModuleOptions = {},
    @Optional()
    @Inject(TERMINUS_LOGGER)
    private readonly logger?: LoggerService,
  ) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.isShuttingDown = true;
    const timeoutMs = this.terminusOptions.gracefulShutdownTimeoutMs ?? 0;
    if (timeoutMs <= 0) {
      return;
    }
    this.logger?.log?.(`Received termination signal ${signal ?? ""}`);
    if (!signal || signal === "SIGTERM") {
      this.logger?.log?.(`Awaiting ${timeoutMs}ms before shutdown`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        if (
          typeof timer === "object" &&
          timer !== null &&
          "unref" in timer &&
          typeof timer.unref === "function"
        ) {
          timer.unref();
        }
      });
      this.logger?.log?.("Timeout reached, shutting down now");
    }
  }

  async check<const TFns extends readonly HealthIndicatorFunction[]>(
    indicators: TFns,
    options: HealthCheckOptions = {},
  ): Promise<HealthCheckResult<InferHealthIndicatorResults<TFns>>> {
    const timeoutMs =
      options.timeoutMs !== undefined ? Math.max(1, options.timeoutMs) : 5_000;

    const settled = await Promise.all(
      indicators.map((fn, idx) => runIndicatorWithTimeout(fn, idx, timeoutMs)),
    );

    const info: HealthIndicatorResult = {};
    const error: HealthIndicatorResult = {};
    const details: HealthIndicatorResult = {};
    let hasDegraded = false;

    for (const part of settled) {
      if (!part || typeof part !== "object") continue;
      for (const [key, entry] of Object.entries(part)) {
        details[key] = entry;
        if (entry.status === HealthIndicatorStatus.UP) {
          info[key] = entry;
        } else if (entry.status === HealthIndicatorStatus.DEGRADED) {
          info[key] = entry;
          hasDegraded = true;
        } else {
          error[key] = entry;
        }
      }
    }

    const hasError = Object.keys(error).length > 0;
    const status: HealthCheckStatus = this.isShuttingDown
      ? HealthCheckStatus.SHUTTING_DOWN
      : hasError
        ? HealthCheckStatus.ERROR
        : hasDegraded
          ? HealthCheckStatus.DEGRADED
          : HealthCheckStatus.OK;

    const result: HealthCheckResult<InferHealthIndicatorResults<TFns>> = {
      status,
      info: info as Partial<InferHealthIndicatorResults<TFns>>,
      error: error as Partial<InferHealthIndicatorResults<TFns>>,
      details: details as InferHealthIndicatorResults<TFns>,
      timestamp: new Date().toISOString(),
    };

    if (status === HealthCheckStatus.ERROR) {
      if (this.logger && this.terminusOptions.logger !== false) {
        const style = this.terminusOptions.errorLogStyle ?? "json";
        this.logger.error(formatErrorLog(style, details));
      }
      throw new HealthCheckException(result);
    }

    if (status === HealthCheckStatus.SHUTTING_DOWN) {
      throw new HealthCheckException(result);
    }

    return result;
  }
}
