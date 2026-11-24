import {
  AspectPhase,
  Injectable,
  defineAspectPipeline,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";

@Injectable()
export class ShowcaseAspectTrace {
  readonly events: string[] = [];

  record(entry: string): void {
    this.events.push(entry);
  }

  clear(): void {
    this.events.length = 0;
  }
}

@Injectable()
export class ShowcaseObservabilityAspect
  implements MethodAspectHandler<{ label?: string }>
{
  constructor(private readonly trace: ShowcaseAspectTrace) {}

  async intercept(
    ctx: MethodAspectContext<{ label?: string }>,
  ): Promise<unknown> {
    const label = ctx.options?.label ?? String(ctx.methodName);
    this.trace.record(`observability:before:${label}`);
    const result = await ctx.proceed();
    this.trace.record(`observability:after:${label}`);
    return result;
  }
}

@Injectable()
export class ShowcaseAuditAspect
  implements MethodAspectHandler<{ label?: string }>
{
  constructor(private readonly trace: ShowcaseAspectTrace) {}

  async intercept(
    ctx: MethodAspectContext<{ label?: string }>,
  ): Promise<unknown> {
    const label = ctx.options?.label ?? String(ctx.methodName);
    this.trace.record(`audit:before:${label}`);
    const result = await ctx.proceed();
    this.trace.record(`audit:after:${label}`);
    return result;
  }
}

/**
 * Composable AOP Pipeline using semantic `AspectPhase` ordering:
 * Even though `AUDIT` is listed before `OBSERVABILITY` below, Bunest automatically
 * executes `AspectPhase.OBSERVABILITY` (-500) outside `AspectPhase.AUDIT` (200)!
 */
export const AuditedOperation = defineAspectPipeline(
  (label: string) => [
    {
      token: ShowcaseAuditAspect,
      options: { label },
      phase: AspectPhase.AUDIT,
    },
    {
      token: ShowcaseObservabilityAspect,
      options: { label },
      phase: AspectPhase.OBSERVABILITY,
    },
  ],
);
