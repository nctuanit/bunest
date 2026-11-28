import { Injectable, type CanActivate, type ExecutionContext } from "@bunest/core";
import { GqlExecutionContext } from "@bunest/graphql";

@Injectable()
export class CatsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const gqlCtx = GqlExecutionContext.create(context);
    const ctx = gqlCtx.getContext<{ role?: string }>();
    return ctx.role === "admin";
  }
}
