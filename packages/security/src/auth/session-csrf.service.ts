import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  Reflector,
  type CanActivate,
  type CookieOptions,
  type ExecutionContext,
  type ResponseContext,
} from "@bunest/common";
import { extractRequestCookies } from "@bunest/http";
import {
  base64UrlDecode,
  base64UrlDecodeUtf8,
  base64UrlEncode,
  randomToken,
  timingSafeEqualBytes,
  timingSafeEqualString,
  utf8Encode,
} from "../utils/crypto.util";
import { IS_PUBLIC_KEY } from "./auth.decorators";

export const SESSION_COOKIE_OPTIONS = Symbol.for(
  "bunest:security:session_cookie_options",
);
export const CSRF_OPTIONS = Symbol.for("bunest:security:csrf_options");

export interface SessionCookieOptions {
  secret: string | Uint8Array;
  cookieName?: string;
  ttlSeconds?: number;
  cookieOptions?: CookieOptions;
}

interface SignedSessionEnvelope<T> {
  data: T;
  exp: number;
}

/**
 * Signed, HMAC-SHA256-verified HTTP-only cookie session & double-submit CSRF helper.
 */
@Injectable()
export class SessionCookieService {
  private readonly cookieName: string;
  private readonly ttlSeconds: number;
  private readonly cookieOptions: CookieOptions;
  private readonly keyPromise: Promise<CryptoKey>;

  constructor(
    @Inject(SESSION_COOKIE_OPTIONS) options: SessionCookieOptions,
  ) {
    const rawSecret =
      typeof options.secret === "string"
        ? utf8Encode(options.secret)
        : new Uint8Array(options.secret);
    if (rawSecret.byteLength === 0) {
      throw new Error("SessionCookieService requires a non-empty secret");
    }
    this.cookieName = options.cookieName ?? "bunest_session";
    this.ttlSeconds = options.ttlSeconds ?? 3600;
    this.cookieOptions = {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      ...options.cookieOptions,
    };
    this.keyPromise = crypto.subtle.importKey(
      "raw",
      rawSecret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }

  async sign<T extends Record<string, unknown>>(
    data: T,
    ttlSeconds = this.ttlSeconds,
  ): Promise<string> {
    const envelope: SignedSessionEnvelope<T> = {
      data,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
    const encoded = base64UrlEncode(JSON.stringify(envelope));
    const key = await this.keyPromise;
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, utf8Encode(encoded)),
    );
    return `${encoded}.${base64UrlEncode(sig)}`;
  }

  async verify<T extends Record<string, unknown> = Record<string, unknown>>(
    signedValue: string,
    nowSec = Math.floor(Date.now() / 1000),
  ): Promise<T | null> {
    if (typeof signedValue !== "string") {
      return null;
    }
    const dotIdx = signedValue.indexOf(".");
    if (
      dotIdx <= 0 ||
      dotIdx !== signedValue.lastIndexOf(".") ||
      dotIdx === signedValue.length - 1
    ) {
      return null;
    }

    const encoded = signedValue.slice(0, dotIdx);
    const encodedSig = signedValue.slice(dotIdx + 1);

    let providedSig: Uint8Array<ArrayBuffer>;
    try {
      providedSig = base64UrlDecode(encodedSig);
    } catch {
      return null;
    }

    const key = await this.keyPromise;
    const expectedSig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, utf8Encode(encoded)),
    );
    if (!timingSafeEqualBytes(expectedSig, providedSig)) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        base64UrlDecodeUtf8(encoded),
      ) as SignedSessionEnvelope<T>;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.exp !== "number" ||
        nowSec >= parsed.exp
      ) {
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  async setSession<T extends Record<string, unknown>>(
    res: ResponseContext,
    data: T,
    ttlSeconds = this.ttlSeconds,
  ): Promise<string> {
    const signed = await this.sign(data, ttlSeconds);
    res.cookie(this.cookieName, signed, {
      ...this.cookieOptions,
      maxAge: ttlSeconds,
    });
    return signed;
  }

  async getSession<
    T extends Record<string, unknown> = Record<string, unknown>,
  >(req: Request): Promise<T | null> {
    const cookies = extractRequestCookies(req);
    const raw = cookies[this.cookieName];
    if (!raw) {
      return null;
    }
    return this.verify<T>(raw);
  }

  clearSession(res: ResponseContext): void {
    res.clearCookie(this.cookieName, {
      path: this.cookieOptions.path ?? "/",
      domain: this.cookieOptions.domain,
    });
  }

  generateCsrfToken(byteLength = 32): string {
    return randomToken(byteLength);
  }

  setCsrfCookie(
    res: ResponseContext,
    token = this.generateCsrfToken(),
    cookieName = "csrf_token",
    options?: CookieOptions,
  ): string {
    res.cookie(cookieName, token, {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      ...options,
    });
    return token;
  }
}

export interface CsrfGuardOptions {
  cookieName?: string;
  headerName?: string;
  ignoredMethods?: readonly string[];
  skipPublic?: boolean;
}

const DEFAULT_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Double-submit cookie CSRF guard comparing cookie token and request header
 * in constant time for state-changing HTTP methods.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly cookieName: string;
  private readonly headerName: string;
  private readonly ignoredMethods: Set<string>;
  private readonly skipPublic: boolean;

  constructor(
    @Optional() private readonly reflector?: Reflector,
    @Optional()
    @Inject(CSRF_OPTIONS)
    options: CsrfGuardOptions = {},
  ) {
    this.cookieName = options.cookieName ?? "csrf_token";
    this.headerName = (options.headerName ?? "x-csrf-token").toLowerCase();
    this.ignoredMethods = options.ignoredMethods
      ? new Set(options.ignoredMethods.map((m) => m.toUpperCase()))
      : DEFAULT_SAFE_METHODS;
    this.skipPublic = options.skipPublic ?? false;
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.skipPublic && this.reflector) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(
        IS_PUBLIC_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (isPublic) {
        return true;
      }
    }

    const req = context.switchToHttp().getRequest<Request>();
    if (this.ignoredMethods.has(req.method.toUpperCase())) {
      return true;
    }

    const cookies = extractRequestCookies(req);
    const cookieToken = cookies[this.cookieName];
    const headerToken = req.headers.get(this.headerName);

    if (
      !cookieToken ||
      !headerToken ||
      !timingSafeEqualString(cookieToken, headerToken)
    ) {
      throw new ForbiddenException("Invalid or missing CSRF token");
    }

    return true;
  }
}
