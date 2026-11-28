import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type ResponseContext,
} from "@bunest/core";
import { logJson } from "./config";
import { MetricsService } from "./metrics.service";

@Injectable()
export class RequestTelemetryInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const url = new URL(req.url);
    const requestId =
      req.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const start = performance.now();

    const isProbe = url.pathname === "/live" || url.pathname === "/ready";
    if (!isProbe) {
      this.metrics.beginRequest();
    }

    let status = 200;
    try {
      const result = await next.handle();
      const res = http.getResponse<ResponseContext>();
      res?.header("x-request-id", requestId);
      if (result instanceof Response) {
        status = result.status;
        const headers = new Headers(result.headers);
        headers.set("x-request-id", requestId);
        return new Response(result.body, {
          status: result.status,
          statusText: result.statusText,
          headers,
        });
      }
      status = res?.getStatus() ?? (req.method === "POST" ? 201 : 200);
      return result;
    } catch (err) {
      const maybeHttp = err as { getStatus?: () => number; status?: number };
      status =
        typeof maybeHttp?.getStatus === "function"
          ? maybeHttp.getStatus()
          : typeof maybeHttp?.status === "number"
            ? maybeHttp.status
            : 500;
      throw err;
    } finally {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      if (!isProbe) {
        this.metrics.endRequest(status, durationMs);
      }
      if (!isProbe && url.pathname !== "/metrics") {
        logJson(status >= 500 ? "error" : "info", "http_request", {
          requestId,
          method: req.method,
          path: url.pathname,
          status,
          durationMs,
        });
      }
    }
  }
}
