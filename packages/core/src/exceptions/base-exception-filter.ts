import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  IntrinsicException,
  Logger,
  Optional,
  type ArgumentsHost,
  type ExceptionFilter,
  type HttpServer,
} from "../common/index";
import { getCurrentRequestContext } from "../http/index";
import { HttpAdapterHost } from "../helpers/http-adapter-host";

/**
 * Base HTTP exception filter matching NestJS `BaseExceptionFilter`, enabling
 * custom filters to extend and delegate back via `super.catch(exception, host)`.
 */
@Catch()
export class BaseExceptionFilter<T = any> implements ExceptionFilter<T> {
  private static readonly logger = new Logger("ExceptionsHandler");

  @Optional()
  @Inject(HttpAdapterHost)
  protected readonly httpAdapterHost?: HttpAdapterHost;

  constructor(@Optional() protected readonly applicationRef?: HttpServer) {}

  catch(exception: T, host: ArgumentsHost): Response | void {
    const adapter =
      this.applicationRef ??
      (this.httpAdapterHost?.httpAdapter as unknown as HttpServer | undefined);

    if (!(exception instanceof HttpException)) {
      return this.handleUnknownError(exception, host, adapter);
    }

    const res = host.switchToHttp().getResponse();
    const status = exception.getStatus();
    const payload = exception.toJSON();
    const headers = exception.getHeaders();

    if (headers && res && typeof res.header === "function") {
      for (const [k, v] of Object.entries(headers)) {
        res.header(k, v);
      }
    }

    if (adapter && typeof adapter.reply === "function") {
      return adapter.reply(res, payload, status) as Response | void;
    }

    const reqCtx = getCurrentRequestContext();
    const responseHeaders = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      ...(headers ?? {}),
    });
    return new Response(
      JSON.stringify({
        ...payload,
        timestamp: payload.timestamp ?? new Date().toISOString(),
        path: payload.path ?? reqCtx?.pathname ?? "/",
      }),
      { status, headers: responseHeaders },
    );
  }

  handleUnknownError(
    exception: T,
    host: ArgumentsHost,
    applicationRef?: HttpServer,
  ): Response | void {
    const body = this.isHttpError(exception)
      ? {
          statusCode: exception.statusCode,
          message: this.getHttpErrorMessage(exception),
        }
      : {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: "Internal server error",
        };

    if (!(exception instanceof IntrinsicException)) {
      if (this.isExceptionObject(exception)) {
        BaseExceptionFilter.logger.error(exception.message, exception.stack);
      } else {
        BaseExceptionFilter.logger.error(String(exception));
      }
    }

    const res = host.switchToHttp().getResponse();
    if (applicationRef && typeof applicationRef.reply === "function") {
      return applicationRef.reply(res, body, body.statusCode) as Response | void;
    }

    return new Response(JSON.stringify(body), {
      status: body.statusCode,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  isExceptionObject(err: unknown): err is Error {
    return typeof err === "object" && err !== null && "message" in err;
  }

  isHttpError(
    err: unknown,
  ): err is { statusCode: number; message: string; expose?: boolean } {
    return (
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      "message" in err &&
      typeof (err as { statusCode?: unknown }).statusCode === "number" &&
      typeof (err as { message?: unknown }).message === "string"
    );
  }

  getHttpErrorMessage(err: {
    statusCode: number;
    message: string;
    expose?: boolean;
  }): string {
    if (err.expose === false && err.statusCode >= 500) {
      return "Internal server error";
    }
    return err.message;
  }
}
