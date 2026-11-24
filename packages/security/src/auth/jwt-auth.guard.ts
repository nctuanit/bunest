import {
  Inject,
  Injectable,
  Optional,
  Reflector,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { extractRequestCookies } from "@bunest/core/http";
import type { JwtPayload, JwtVerifyOptions } from "../jwt/jwt.interface";
import { JwtService } from "../jwt/jwt.service";
import { IS_PUBLIC_KEY, setRequestUser } from "./auth.decorators";

export const JWT_AUTH_GUARD_OPTIONS = Symbol.for(
  "bunest:security:jwt_auth_guard_options",
);

export type TokenExtractor = (
  req: Request,
  ctx: ExecutionContext,
) => string | null | undefined;

export interface JwtAuthGuardOptions {
  extractToken?: TokenExtractor;
  cookieName?: string;
  verifyOptions?: JwtVerifyOptions;
  validate?: (
    payload: JwtPayload,
    req: Request,
    ctx: ExecutionContext,
  ) => unknown | Promise<unknown>;
}

export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) {
    return null;
  }
  const spaceIdx = auth.indexOf(" ");
  if (spaceIdx === -1) {
    return null;
  }
  const scheme = auth.slice(0, spaceIdx);
  if (scheme.toLowerCase() !== "bearer") {
    return null;
  }
  const token = auth.slice(spaceIdx + 1).trim();
  return token.length > 0 ? token : null;
}

export function extractCookieToken(cookieName: string): TokenExtractor {
  return (req: Request): string | null => {
    const cookies = extractRequestCookies(req);
    const value = cookies[cookieName];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
}

/**
 * Authentication guard verifying Bearer or cookie JWTs via `JwtService`,
 * attaching the authenticated user for `@CurrentUser()`, and honoring `@Public()`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    @Optional()
    @Inject(JWT_AUTH_GUARD_OPTIONS)
    private readonly options?: JwtAuthGuardOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    let token: string | null | undefined;

    if (this.options?.extractToken) {
      token = this.options.extractToken(req, context);
    } else {
      token = extractBearerToken(req);
      if (!token && this.options?.cookieName) {
        token = extractCookieToken(this.options.cookieName)(req, context);
      }
    }

    if (!token) {
      throw new UnauthorizedException("Missing authentication token");
    }

    const payload = await this.jwtService.verify(
      token,
      this.options?.verifyOptions,
    );

    const user = this.options?.validate
      ? await this.options.validate(payload, req, context)
      : payload;

    if (user === null || user === undefined || user === false) {
      throw new UnauthorizedException("Authentication validation failed");
    }

    setRequestUser(req, user);
    return true;
  }
}
