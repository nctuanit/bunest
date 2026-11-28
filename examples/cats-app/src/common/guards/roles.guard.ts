import {
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { ROLES_KEY } from "../decorators/roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.get("x-roles") ?? "";
    const userRoles = header
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);

    return requiredRoles.some((role) => userRoles.includes(role));
  }
}
