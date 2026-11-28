import {
  Injectable,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";
import { ShowcaseAspectTrace } from "./showcase-aspect-trace";

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
