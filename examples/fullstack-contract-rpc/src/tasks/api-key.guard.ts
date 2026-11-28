import { Injectable, type CanActivate, type ExecutionContext } from "@bunest/core";

export const DEMO_API_KEY = "bunest-contract-secret";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    return req.headers.get("x-api-key") === DEMO_API_KEY;
  }
}
