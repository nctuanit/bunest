import {
  ForbiddenException,
  Injectable,
  Optional,
  Reflector,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from "@bunest/core";
import { ModuleRef } from "@bunest/core";
import {
  POLICIES_KEY,
  getRequestUser,
  type IPolicyHandler,
  type PolicyHandler,
} from "./auth.decorators";

function isPolicyHandlerClass(
  handler: PolicyHandler,
): handler is Type<IPolicyHandler> {
  return (
    typeof handler === "function" &&
    typeof (handler as { prototype?: { handle?: unknown } }).prototype
      ?.handle === "function"
  );
}

function isPolicyHandlerInstance(
  handler: PolicyHandler,
): handler is IPolicyHandler {
  return (
    typeof handler === "object" &&
    handler !== null &&
    typeof handler.handle === "function"
  );
}

/**
 * ABAC / policy-based authorization guard enforcing `@CheckPolicies(...)` handlers.
 * Supports callback functions, handler instances, and DI-injectable handler classes.
 */
@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handlers = this.reflector.getAllAndMerge<PolicyHandler[]>(
      POLICIES_KEY,
      [context.getClass(), context.getHandler()],
    );

    if (!handlers || handlers.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const user = getRequestUser(req);

    for (const handler of handlers) {
      let allowed: boolean;
      if (isPolicyHandlerInstance(handler)) {
        allowed = await handler.handle(user, context);
      } else if (isPolicyHandlerClass(handler)) {
        const instance = this.moduleRef
          ? await this.moduleRef
              .resolve(handler, undefined, { strict: false })
              .catch(() => this.moduleRef!.create(handler))
          : new handler();
        allowed = await instance.handle(user, context);
      } else {
        allowed = await handler(user, context);
      }

      if (!allowed) {
        throw new ForbiddenException("Access denied by policy");
      }
    }

    return true;
  }
}
