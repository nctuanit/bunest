import {
  All,
  Controller,
  Inject,
  Injectable,
  Module,
  Req,
  type DynamicModule,
  type ExecutionContext,
  type InjectionToken,
  type ModuleImport,
  type Provider,
  type Type,
} from "@bunest/core";
import { AuthenticationModule } from "../authentication.module";
import { Public } from "../decorators/public.decorator";
import type {
  AuthenticationResult,
  MfaState,
} from "../interfaces/authentication-result.interface";
import { AuthenticationProvider } from "../providers/authentication.provider";
import { AuthenticationRegistry } from "../services/authentication-registry.service";
import {
  extractWebHeaders,
  normalizeAuthMountPath,
} from "./web-request.util";

/** Injection token holding the configured Better Auth instance. */
export const BETTER_AUTH_INSTANCE: unique symbol = Symbol.for(
  "bunest:security:better_auth_instance",
);

/** Internal options token for `BetterAuthModule`. */
export const BETTER_AUTH_MODULE_OPTIONS: unique symbol = Symbol.for(
  "bunest:security:better_auth_options",
);

/**
 * Parameter decorator injecting the Better Auth instance registered by `BetterAuthModule`.
 */
export function InjectBetterAuth(): ParameterDecorator {
  return Inject(BETTER_AUTH_INSTANCE);
}

/**
 * Structural contract compatible with `betterAuth(...)` from `better-auth`
 * without adding any external runtime dependency (`ADR-017`).
 */
export interface BetterAuthLike<TUser = unknown, TSession = unknown> {
  handler(request: Request): Promise<Response> | Response;
  api: {
    getSession(input: {
      headers: Headers;
    }):
      | Promise<{ user: TUser; session: TSession } | null | undefined>
      | { user: TUser; session: TSession }
      | null
      | undefined;
  };
  options?: {
    basePath?: string;
  };
}

export interface BetterAuthSessionEnvelope<TUser = unknown, TSession = unknown> {
  readonly user: TUser;
  readonly session: TSession;
}

export interface BetterAuthSharedOptions<TUser = unknown, TSession = unknown> {
  /**
   * URL prefix where `auth.handler(req)` is mounted.
   * Defaults to `auth.options?.basePath ?? "/api/auth"`.
   */
  readonly basePath?: string;
  /**
   * Automatically mount `auth.handler(req)` on `basePath` and `basePath/*`.
   * Set to `false` if you mount Better Auth manually or only verify sessions.
   * @default true
   */
  readonly mountHandler?: boolean;
  /**
   * Provider execution order inside `AuthenticationRegistry`.
   * Lower numbers run first.
   * @default 0
   */
  readonly order?: number;
  /**
   * `WWW-Authenticate` realm sent on 401 responses.
   * @default "api"
   */
  readonly realm?: string;
  /**
   * Import `AuthenticationModule.forRoot({ globalGuard, isGlobal })` automatically.
   * Set to `false` when your app already imports `AuthenticationModule.forRoot(...)`
   * (for example, when combining Better Auth with `ApiKeyProvider` or `JwtBearerProvider`).
   * @default true
   */
  readonly registerAuthenticationModule?: boolean;
  /**
   * Whether `AuthenticationModule` registers `AuthenticationGuard` globally.
   * Only used when `registerAuthenticationModule !== false`.
   * @default true
   */
  readonly globalGuard?: boolean;
  /**
   * Make `BETTER_AUTH_INSTANCE` and `BetterAuthProvider` globally injectable.
   * @default true
   */
  readonly isGlobal?: boolean;
  /**
   * Optional hook to customize the resolved `{ user, session, mfa }` returned to
   * `@CurrentUser()`, `@CurrentSession()`, and `@bunest/security/authz` policies.
   */
  readonly mapResult?: (
    envelope: BetterAuthSessionEnvelope<TUser, TSession>,
    context: ExecutionContext,
  ) =>
    | Promise<AuthenticationResult<TUser, TSession> | null>
    | AuthenticationResult<TUser, TSession>
    | null;
}

export interface BetterAuthModuleOptions<
  TUser = unknown,
  TSession = unknown,
  TAuth extends BetterAuthLike<TUser, TSession> = BetterAuthLike<
    TUser,
    TSession
  >,
> extends BetterAuthSharedOptions<TUser, TSession> {
  readonly auth: TAuth;
}

export interface BetterAuthModuleAsyncOptions<
  TUser = unknown,
  TSession = unknown,
  TAuth extends BetterAuthLike<TUser, TSession> = BetterAuthLike<
    TUser,
    TSession
  >,
> extends BetterAuthSharedOptions<TUser, TSession> {
  readonly imports?: ModuleImport[];
  readonly inject?: InjectionToken[];
  readonly useFactory: (...args: any[]) => Promise<TAuth> | TAuth;
}

/**
 * Credential provider bridging Better Auth (`auth.api.getSession({ headers })`)
 * directly into Bunest's `AuthenticationGuard`, `@CurrentUser()`, `@CurrentSession()`,
 * `AuthenticationContext`, and `@bunest/security/authz` (`@Policy()` / `@Can()`).
 */
@Injectable()
export class BetterAuthProvider<
  TUser = unknown,
  TSession = unknown,
> extends AuthenticationProvider<TUser, TSession> {
  private readonly realm: string;

  constructor(
    @Inject(BETTER_AUTH_INSTANCE)
    private readonly auth: BetterAuthLike<TUser, TSession>,
    @Inject(BETTER_AUTH_MODULE_OPTIONS)
    private readonly options: BetterAuthSharedOptions<TUser, TSession>,
    registry: AuthenticationRegistry,
  ) {
    super();
    this.realm = options.realm ?? "api";
    registry.registerProvider(this, { order: options.order ?? 0 });
  }

  override async authenticate(
    context: ExecutionContext,
  ): Promise<AuthenticationResult<TUser, TSession> | null> {
    const headers = extractWebHeaders(context);
    const result = await this.auth.api.getSession({ headers });
    if (!result || result.user === null || result.user === undefined) {
      return null;
    }

    if (this.options.mapResult) {
      return this.options.mapResult(result, context);
    }

    const sessionRecord = result.session as Record<string, unknown> | undefined;
    const mfa: MfaState | undefined =
      sessionRecord && sessionRecord.twoFactorVerified === true
        ? "verified"
        : undefined;

    return {
      user: result.user,
      session: result.session,
      ...(mfa ? { mfa } : {}),
    };
  }

  override challenge(): string {
    return `Bearer realm="${this.realm}"`;
  }
}

let betterAuthControllerSeq = 0;

function createBetterAuthMountController(basePath: string): Type<unknown> {
  const mountPath = normalizeAuthMountPath(basePath, "/api/auth");

  @Public()
  @Controller(mountPath)
  class BetterAuthHandlerController {
    constructor(
      @Inject(BETTER_AUTH_INSTANCE)
      private readonly auth: BetterAuthLike,
    ) {}

    @All()
    handleRoot(@Req() req: Request): Promise<Response> | Response {
      return this.auth.handler(req);
    }

    @All("*")
    handleWildcard(@Req() req: Request): Promise<Response> | Response {
      return this.auth.handler(req);
    }
  }

  betterAuthControllerSeq++;
  Object.defineProperty(BetterAuthHandlerController, "name", {
    value: `BetterAuthHandlerController_${betterAuthControllerSeq}`,
  });

  return BetterAuthHandlerController;
}

/**
 * First-class, zero-dependency Better Auth integration for Bunest.
 *
 * - Mounts `auth.handler(req)` directly on `/api/auth` & `/api/auth/*` (Web `Request` -> `Response`,
 *   preserving streaming bodies, redirects, and multi-value `Set-Cookie` headers).
 * - Resolves sessions across HTTP, WebSocket, GraphQL, and MCP via `BetterAuthProvider`.
 * - Integrates seamlessly with `@CurrentUser()`, `@CurrentSession()`, `@Public()`, `@Authenticate()`,
 *   and `@bunest/security/authz` (`@Policy()` / `@Can()`).
 */
@Module({})
export class BetterAuthModule {
  static forRoot<
    TUser = unknown,
    TSession = unknown,
    TAuth extends BetterAuthLike<TUser, TSession> = BetterAuthLike<
      TUser,
      TSession
    >,
  >(options: BetterAuthModuleOptions<TUser, TSession, TAuth>): DynamicModule {
    const isGlobal = options.isGlobal !== false;
    const mountHandler = options.mountHandler !== false;
    const mountPath = options.basePath ?? options.auth.options?.basePath ?? "/api/auth";

    const imports: ModuleImport[] = [];
    if (options.registerAuthenticationModule !== false) {
      imports.push(
        AuthenticationModule.forRoot({
          isGlobal,
          globalGuard: options.globalGuard !== false,
        }),
      );
    }

    const controllers = mountHandler
      ? [createBetterAuthMountController(mountPath)]
      : [];

    const providers: Provider[] = [
      { provide: BETTER_AUTH_INSTANCE, useValue: options.auth },
      { provide: BETTER_AUTH_MODULE_OPTIONS, useValue: options },
      BetterAuthProvider,
    ];

    return {
      module: BetterAuthModule,
      global: isGlobal,
      imports,
      controllers,
      providers,
      exports: [BETTER_AUTH_INSTANCE, BetterAuthProvider],
    };
  }

  static forRootAsync<
    TUser = unknown,
    TSession = unknown,
    TAuth extends BetterAuthLike<TUser, TSession> = BetterAuthLike<
      TUser,
      TSession
    >,
  >(
    options: BetterAuthModuleAsyncOptions<TUser, TSession, TAuth>,
  ): DynamicModule {
    const isGlobal = options.isGlobal !== false;
    const mountHandler = options.mountHandler !== false;
    const mountPath = options.basePath ?? "/api/auth";

    const imports: ModuleImport[] = [...(options.imports ?? [])];
    if (options.registerAuthenticationModule !== false) {
      imports.push(
        AuthenticationModule.forRoot({
          isGlobal,
          globalGuard: options.globalGuard !== false,
        }),
      );
    }

    const controllers = mountHandler
      ? [createBetterAuthMountController(mountPath)]
      : [];

    const providers: Provider[] = [
      {
        provide: BETTER_AUTH_INSTANCE,
        inject: options.inject ?? [],
        useFactory: options.useFactory,
      },
      { provide: BETTER_AUTH_MODULE_OPTIONS, useValue: options },
      BetterAuthProvider,
    ];

    return {
      module: BetterAuthModule,
      global: isGlobal,
      imports,
      controllers,
      providers,
      exports: [BETTER_AUTH_INSTANCE, BetterAuthProvider],
    };
  }
}
