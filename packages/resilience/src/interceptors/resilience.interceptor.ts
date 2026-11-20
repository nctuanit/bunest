import {
  Inject,
  Injectable,
  Optional,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/common";
import { HttpAdapterHost } from "@bunest/core";
import { ResilienceError } from "../errors/resilience.error";
import type { ResilienceModuleOptions } from "../interfaces/resilience-module-options.interface";
import { executeEntrypoint } from "../policies/resilience.policy";
import { RESILIENCE_MODULE_OPTIONS } from "../resilience.module-definition";
import {
  EntrypointPlanner,
  type EntrypointPlan,
} from "../services/entrypoint-planner.service";
import {
  headersSent,
  TransportErrorMapper,
} from "../utils/transport-errors.util";

/** RFC 9110 safe methods: repeating them has no side effects by definition. */
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Registered globally by `ResilienceModule` (`APP_INTERCEPTOR`), so it runs
 * for every HTTP route, resolver, message handler and gateway message, and is
 * a no-op (apart from error mapping) for handlers without resilience
 * metadata. Being global, it is outside controller- and method-level
 * interceptors: a retry re-runs those, the pipes and the handler, but not
 * guards or middleware.
 */
@Injectable()
export class ResilienceInterceptor implements BunestInterceptor {
  private readonly mapper: TransportErrorMapper;
  private readonly mapErrors: boolean;

  constructor(
    private readonly planner: EntrypointPlanner,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
    @Optional()
    @Inject(RESILIENCE_MODULE_OPTIONS)
    options?: ResilienceModuleOptions,
  ) {
    this.mapper = new TransportErrorMapper(adapterHost);
    this.mapErrors = options?.mapErrors ?? true;
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const plan = this.planner.planFor(context.getClass(), context.getHandler());
    try {
      return await (plan
        ? this.execute(plan, context, next)
        : next.handle());
    } catch (error) {
      if (this.mapErrors && error instanceof ResilienceError) {
        throw await this.mapper.map(error, context);
      }
      throw error;
    }
  }

  private execute(
    plan: EntrypointPlan,
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const policy =
      plan.hasRetry && this.canRepeat(plan, context)
        ? plan.withRetry
        : plan.withoutRetry;
    return executeEntrypoint(policy, () => next.handle(), {
      source: plan.source,
      invocation: context,
      committed: plan.sse ? undefined : () => this.isCommitted(context),
    });
  }

  private canRepeat(plan: EntrypointPlan, context: ExecutionContext): boolean {
    if (plan.requestStream) {
      return false;
    }
    if (plan.idempotent) {
      return true;
    }
    switch (context.getType<string>()) {
      case "http": {
        const req = context.switchToHttp().getRequest<{ method?: string }>();
        return SAFE_HTTP_METHODS.has(String(req?.method).toUpperCase());
      }
      case "graphql": {
        const info = context.getArgByIndex<{
          operation?: { operation?: string };
        }>(3);
        return info?.operation?.operation === "query";
      }
      default:
        return plan.retryOnMethod;
    }
  }

  private isCommitted(context: ExecutionContext): boolean {
    if (context.getType<string>() !== "http") {
      return false;
    }
    return headersSent(
      context.switchToHttp().getResponse<unknown>(),
      this.adapterHost?.httpAdapter,
    );
  }
}
