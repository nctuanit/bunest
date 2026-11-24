import {
  Injectable,
  getMethodAspects,
  type MethodAspectContext,
  type MethodAspectHandler,
  type Type,
} from "@bunest/core";
import type { ResilienceAspectSlotOptions } from "../decorators/resilience-decorator.util";
import { executeEntrypoint } from "../policies/resilience.policy";
import { RESILIENCE_METHOD_ASPECT } from "../resilience.constants";
import { EntrypointPlanner } from "../services/entrypoint-planner.service";
import {
  collectFallbackTargetMethods,
  hasResilienceMetadata,
  isEntrypointMethod,
} from "../utils/entrypoint-detection.util";

/**
 * Core Method Aspect handler that executes `@Retry`, `@Timeout`, `@CircuitBreaker`,
 * `@Bulkhead`, `@Fallback`, and `@Resilience` on `@Injectable()` service methods
 * (and non-handler helper methods), while transparently yielding transport
 * entrypoints (HTTP routes, GraphQL resolvers, WS/RPC handlers) to
 * `ResilienceInterceptor` so they are never double-wrapped.
 */
@Injectable()
export class ResilienceMethodAspectHandler implements MethodAspectHandler<ResilienceAspectSlotOptions> {
  private readonly primarySlotCache = new WeakMap<
    Type,
    Map<string | symbol, ResilienceAspectSlotOptions | undefined>
  >();
  private readonly fallbackTargetsCache = new WeakMap<Type, Set<string>>();

  constructor(private readonly planner: EntrypointPlanner) {}

  intercept(ctx: MethodAspectContext<ResilienceAspectSlotOptions>): unknown {
    // If multiple resilience aspect slots exist (e.g., class-level + method-level or inheritance),
    // execute the unified EntrypointPlanner pipeline once at the outermost slot only.
    const primarySlot = this.getPrimarySlot(ctx.targetClass, ctx.methodName);
    if (primarySlot !== undefined && ctx.options !== primarySlot) {
      return ctx.proceed();
    }

    const protoMethod = (
      ctx.targetClass.prototype as Record<string | symbol, unknown> | undefined
    )?.[ctx.methodName];

    if (typeof protoMethod !== "function") {
      return ctx.proceed();
    }

    // Transport entrypoints (controllers, resolvers, gateways, RPC handlers) are handled
    // by ResilienceInterceptor (with HTTP safety rules, @Signal, error status mapping).
    if (isEntrypointMethod(ctx.targetClass, protoMethod)) {
      return ctx.proceed();
    }

    // Never wrap a @Fallback("recover") target method with inherited class-level policies
    // unless that recovery method declares its own explicit resilience decorators.
    if (
      typeof ctx.methodName === "string" &&
      !hasResilienceMetadata(protoMethod) &&
      this.getFallbackTargets(ctx.targetClass).has(ctx.methodName)
    ) {
      return ctx.proceed();
    }

    const plan = this.planner.planFor(ctx.targetClass, protoMethod);
    if (!plan) {
      return ctx.proceed();
    }

    const policy = plan.hasRetry ? plan.withRetry : plan.withoutRetry;
    return executeEntrypoint(policy, () => ctx.proceed(), {
      source: plan.source,
      invocation: ctx,
    });
  }

  private getPrimarySlot(
    cls: Type,
    methodName: string | symbol,
  ): ResilienceAspectSlotOptions | undefined {
    let byMethod = this.primarySlotCache.get(cls);
    if (!byMethod) {
      byMethod = new Map();
      this.primarySlotCache.set(cls, byMethod);
    }
    if (!byMethod.has(methodName)) {
      const slots = getMethodAspects(cls, methodName).filter(
        (entry) => entry.token === RESILIENCE_METHOD_ASPECT,
      );
      const first =
        slots.length > 1
          ? (slots[0]?.options as ResilienceAspectSlotOptions | undefined)
          : undefined;
      byMethod.set(methodName, first);
    }
    return byMethod.get(methodName);
  }

  private getFallbackTargets(cls: Type): Set<string> {
    let set = this.fallbackTargetsCache.get(cls);
    if (!set) {
      set = collectFallbackTargetMethods(cls);
      this.fallbackTargetsCache.set(cls, set);
    }
    return set;
  }
}
