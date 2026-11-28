import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  type ResponseContext,
} from "@bunest/core";

@Injectable()
export class LoggingInterceptor implements BunestInterceptor {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const start = performance.now();
    const result = await next.handle();
    const durationMs = (performance.now() - start).toFixed(2);
    const res = context.switchToHttp().getResponse<ResponseContext>();
    res.header("X-Response-Time", `${durationMs}ms`);
    return result;
  }
}
