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
import type { AuthenticationResult } from "../interfaces/authentication-result.interface";
import { AuthenticationProvider } from "../providers/authentication.provider";
import { AuthenticationRegistry } from "../services/authentication-registry.service";
import {
  extractBearerToken,
  extractCookieValue,
  extractHttpRequest,
  extractWebHeaders,
  normalizeAuthMountPath,
} from "./web-request.util";

/** Injection token for options resolved by `WebAuthModule`. */
export const WEB_AUTH_MODULE_OPTIONS: unique symbol = Symbol.for(
  "bunest:security:web_auth_options",
);

/**
 * Context passed to `getSession()` inside `WebAuthModule` / `ExternalSessionProvider`.
 * Works seamlessly for Auth.js (`@auth/core`), Lucia, Supabase `auth.getUser()`, or custom engines.
 */
export interface WebAuthSessionContext {
  readonly context: ExecutionContext;
  readonly headers: Headers;
  readonly request?: Request;
  readonly bearerToken: string | null | undefined;
  cookie(name: string): string | undefined;
}

export type WebAuthHandler = (request: Request) => Promise<Response> | Response;

export type WebAuthSessionResolver<TUser = unknown, TSession = unknown> = (
  ctx: WebAuthSessionContext,
) =>
  | Promise<AuthenticationResult<TUser, TSession> | null | undefined>
  | AuthenticationResult<TUser, TSession>
  | null
  | undefined;

export interface WebAuthModuleOptions<TUser = unknown, TSession = unknown> {
  /**
   * Optional Web Standard `(request: Request) => Promise<Response> | Response` handler
   * (for example Auth.js `Auth(req, authConfig)`). When provided, mounted automatically
   * at `basePath` and `basePath/*` as `@Public()` routes.
   */
  readonly handler?: WebAuthHandler;
  /**
   * Mount prefix for `handler`.
   * @default "/api/auth"
   */
  readonly basePath?: string;
  /**
   * Resolves `{ user, session, mfa? }` for every protected route (HTTP, WS, GraphQL, MCP).
   * Return `null` or `undefined` when no credentials are present or valid.
   */
  readonly getSession: WebAuthSessionResolver<TUser, TSession>;
  /**
   * Provider execution order inside `AuthenticationRegistry`.
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
   * @default true
   */
  readonly registerAuthenticationModule?: boolean;
  /**
   * Whether `AuthenticationModule` registers `AuthenticationGuard` globally.
   * @default true
   */
  readonly globalGuard?: boolean;
  /**
   * Make `ExternalSessionProvider` globally injectable.
   * @default true
   */
  readonly isGlobal?: boolean;
}

export interface WebAuthModuleAsyncOptions<
  TUser = unknown,
  TSession = unknown,
> {
  readonly basePath?: string;
  /**
   * Set to `true` when the async factory returns a `handler` that should be mounted at `basePath`.
   * @default false
   */
  readonly mountHandler?: boolean;
  readonly registerAuthenticationModule?: boolean;
  readonly globalGuard?: boolean;
  readonly isGlobal?: boolean;
  readonly imports?: ModuleImport[];
  readonly inject?: InjectionToken[];
  readonly useFactory: (
    ...args: any[]
  ) =>
    | Promise<WebAuthModuleOptions<TUser, TSession>>
    | WebAuthModuleOptions<TUser, TSession>;
}

/**
 * Generic Web-Standard session provider for integrating Auth.js (`@auth/core`),
 * Lucia, Supabase server checks, or custom session resolvers into `AuthenticationModule`.
 */
@Injectable()
export class ExternalSessionProvider<
  TUser = unknown,
  TSession = unknown,
> extends AuthenticationProvider<TUser, TSession> {
  private readonly realm: string;

  constructor(
    @Inject(WEB_AUTH_MODULE_OPTIONS)
    private readonly options: WebAuthModuleOptions<TUser, TSession>,
    registry: AuthenticationRegistry,
  ) {
    super();
    this.realm = options.realm ?? "api";
    registry.registerProvider(this, { order: options.order ?? 0 });
  }

  override async authenticate(
    context: ExecutionContext,
  ): Promise<AuthenticationResult<TUser, TSession> | null> {
    const resolved = await this.options.getSession({
      context,
      headers: extractWebHeaders(context),
      request: extractHttpRequest(context),
      bearerToken: extractBearerToken(context),
      cookie: (name) => extractCookieValue(context, name),
    });

    if (!resolved || resolved.user === null || resolved.user === undefined) {
      return null;
    }

    return resolved;
  }

  override challenge(): string {
    return `Bearer realm="${this.realm}"`;
  }
}

let webAuthControllerSeq = 0;

function createWebAuthMountController(basePath: string): Type<unknown> {
  const mountPath = normalizeAuthMountPath(basePath, "/api/auth");

  @Public()
  @Controller(mountPath)
  class WebAuthHandlerController {
    constructor(
      @Inject(WEB_AUTH_MODULE_OPTIONS)
      private readonly options: WebAuthModuleOptions,
    ) {}

    @All()
    handleRoot(@Req() req: Request): Promise<Response> | Response {
      if (!this.options.handler) {
        return new Response("Auth handler not configured", { status: 404 });
      }
      return this.options.handler(req);
    }

    @All("*")
    handleWildcard(@Req() req: Request): Promise<Response> | Response {
      if (!this.options.handler) {
        return new Response("Auth handler not configured", { status: 404 });
      }
      return this.options.handler(req);
    }
  }

  webAuthControllerSeq++;
  Object.defineProperty(WebAuthHandlerController, "name", {
    value: `WebAuthHandlerController_${webAuthControllerSeq}`,
  });

  return WebAuthHandlerController;
}

/**
 * Mounts any Web-Standard auth library (Auth.js `@auth/core`, Lucia, custom session APIs)
 * directly into Bunest's `AuthenticationModule` & `@bunest/security/authz` pipeline
 * with zero external runtime dependencies.
 */
@Module({})
export class WebAuthModule {
  static forRoot<TUser = unknown, TSession = unknown>(
    options: WebAuthModuleOptions<TUser, TSession>,
  ): DynamicModule {
    const isGlobal = options.isGlobal !== false;
    const imports: ModuleImport[] = [];
    if (options.registerAuthenticationModule !== false) {
      imports.push(
        AuthenticationModule.forRoot({
          isGlobal,
          globalGuard: options.globalGuard !== false,
        }),
      );
    }

    const controllers = options.handler
      ? [createWebAuthMountController(options.basePath ?? "/api/auth")]
      : [];

    const providers: Provider[] = [
      { provide: WEB_AUTH_MODULE_OPTIONS, useValue: options },
      ExternalSessionProvider,
    ];

    return {
      module: WebAuthModule,
      global: isGlobal,
      imports,
      controllers,
      providers,
      exports: [ExternalSessionProvider],
    };
  }

  static forRootAsync<TUser = unknown, TSession = unknown>(
    options: WebAuthModuleAsyncOptions<TUser, TSession>,
  ): DynamicModule {
    const isGlobal = options.isGlobal !== false;
    const imports: ModuleImport[] = [...(options.imports ?? [])];
    if (options.registerAuthenticationModule !== false) {
      imports.push(
        AuthenticationModule.forRoot({
          isGlobal,
          globalGuard: options.globalGuard !== false,
        }),
      );
    }

    const controllers = options.mountHandler
      ? [createWebAuthMountController(options.basePath ?? "/api/auth")]
      : [];

    const providers: Provider[] = [
      {
        provide: WEB_AUTH_MODULE_OPTIONS,
        inject: options.inject ?? [],
        useFactory: options.useFactory,
      },
      ExternalSessionProvider,
    ];

    return {
      module: WebAuthModule,
      global: isGlobal,
      imports,
      controllers,
      providers,
      exports: [ExternalSessionProvider],
    };
  }
}
