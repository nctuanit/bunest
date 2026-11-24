import {
  Inject,
  Injectable,
  Module,
  Optional,
  Reflector,
  UnauthorizedException,
  type DynamicModule,
  type ExecutionContext,
  type FactoryDependency,
  type ModuleMetadata,
  type Provider,
  type Type,
} from "@bunest/core";
import { ModuleRef } from "@bunest/core";
import { getCurrentRequestContext } from "@bunest/core/http";
import type { JwtPayload, JwtVerifyOptions } from "../jwt/jwt.interface";
import { JwtService } from "../jwt/jwt.service";
import { JwksClient, type JwksVerifyOptions } from "../oauth/jwks.client";
import { timingSafeEqualString } from "../utils/crypto.util";
import {
  IS_PUBLIC_KEY,
  getRequestUser,
  setRequestUser,
} from "./auth.decorators";
import {
  extractBearerToken,
  extractCookieToken,
  type TokenExtractor,
} from "./jwt-auth.guard";
import {
  defaultPassportInstance,
  type AuthGuardAuthenticateOptions,
  type IAuthGuard,
  type PassportStrategyLike,
} from "./passport.compat";

export const AUTH_MODULE_OPTIONS = Symbol.for(
  "bunest:security:auth_module_options",
);
export const JWT_AUTH_STRATEGY_OPTIONS = Symbol.for(
  "bunest:security:jwt_auth_strategy_options",
);
export const JWKS_JWT_AUTH_STRATEGY_OPTIONS = Symbol.for(
  "bunest:security:jwks_jwt_auth_strategy_options",
);
export const API_KEY_AUTH_STRATEGY_OPTIONS = Symbol.for(
  "bunest:security:api_key_auth_strategy_options",
);
export const BASIC_AUTH_STRATEGY_OPTIONS = Symbol.for(
  "bunest:security:basic_auth_strategy_options",
);

/**
 * Pluggable Passport-style authentication strategy.
 * Return a truthy principal to authenticate the request, return `null` / `undefined` / `false`
 * to decline (allowing fallback to the next strategy), or throw `UnauthorizedException`.
 */
export interface AuthStrategy<TUser = unknown> {
  readonly name: string;
  validate(
    request: Request,
    context: ExecutionContext,
  ):
    | Promise<TUser | null | undefined | false>
    | TUser
    | null
    | undefined
    | false;
}

export type AuthStrategyRegistration = AuthStrategy | Type<AuthStrategy>;

export interface IAuthModuleOptions {
  defaultStrategy?: string | string[];
  session?: boolean;
  property?: string;
  strategies?: readonly AuthStrategyRegistration[];
  imports?: ModuleMetadata["imports"];
  global?: boolean;
  [key: string]: unknown;
}

export class AuthModuleOptions implements IAuthModuleOptions {
  defaultStrategy?: string | string[];
  session?: boolean;
  property?: string;
  strategies?: readonly AuthStrategyRegistration[];
  imports?: ModuleMetadata["imports"];
  global?: boolean;
  [key: string]: unknown;
}

export interface AuthOptionsFactory {
  createAuthOptions(): Promise<IAuthModuleOptions> | IAuthModuleOptions;
}

export interface AuthModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  useExisting?: Type<AuthOptionsFactory>;
  useClass?: Type<AuthOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => IAuthModuleOptions | Promise<IAuthModuleOptions>;
  inject?: FactoryDependency[];
  global?: boolean;
}

/**
 * Registry holding named `AuthStrategy` instances resolved by `AuthGuard(...)`.
 */
@Injectable()
export class AuthStrategyRegistry {
  private readonly strategies = new Map<string, AuthStrategy>();
  private defaultStrategy?: string | string[];

  constructor(
    @Optional()
    @Inject(AUTH_MODULE_OPTIONS)
    options?: {
      strategies?: readonly AuthStrategy[];
      defaultStrategy?: string | string[];
    },
  ) {
    if (options?.strategies) {
      for (const strategy of options.strategies) {
        if (typeof strategy === "object" && strategy !== null) {
          this.register(strategy);
        }
      }
    }
    if (options?.defaultStrategy !== undefined) {
      this.defaultStrategy = Array.isArray(options.defaultStrategy)
        ? [...options.defaultStrategy]
        : options.defaultStrategy;
    }
  }

  register(strategy: AuthStrategy): this {
    if (
      !strategy ||
      typeof strategy.name !== "string" ||
      strategy.name.trim().length === 0
    ) {
      throw new Error("AuthStrategy must declare a non-empty name");
    }
    this.strategies.set(strategy.name, strategy);
    return this;
  }

  unregister(name: string): boolean {
    return this.strategies.delete(name);
  }

  get(name: string): AuthStrategy | undefined {
    return this.strategies.get(name);
  }

  has(name: string): boolean {
    return this.strategies.has(name);
  }

  list(): string[] {
    return Array.from(this.strategies.keys());
  }

  setDefaultStrategy(name: string | readonly string[] | undefined): void {
    this.defaultStrategy = Array.isArray(name)
      ? [...name]
      : (name as string | undefined);
  }

  getDefaultStrategy(): string | string[] | undefined {
    return this.defaultStrategy;
  }
}

interface StrategyOutcome {
  err: unknown;
  user: unknown;
  info?: unknown;
  status?: number;
}

async function executeStrategy(
  strat: AuthStrategy | PassportStrategyLike,
  req: unknown,
  context: ExecutionContext,
  options: Record<string, unknown>,
): Promise<StrategyOutcome> {
  // Passport-style strategy implementing `authenticate(req, options)`
  if ("authenticate" in strat && typeof strat.authenticate === "function") {
    const instance = Object.create(strat) as Record<string, unknown> & {
      authenticate(r: unknown, o: Record<string, unknown>): unknown;
    };
    return await new Promise<StrategyOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: StrategyOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      instance.success = (user: unknown, info?: unknown) =>
        finish({ err: null, user, info });
      instance.fail = (challenge?: unknown, status?: number) =>
        finish({ err: null, user: false, info: challenge, status });
      instance.error = (err: unknown) => finish({ err, user: null });
      instance.pass = () => finish({ err: null, user: undefined });
      instance.redirect = (url: string, status?: number) =>
        finish({
          err: null,
          user: false,
          info: { redirect: url },
          status: status ?? 302,
        });

      try {
        const maybePromise = instance.authenticate(req, options);
        if (
          maybePromise &&
          typeof (maybePromise as PromiseLike<unknown>).then === "function"
        ) {
          Promise.resolve(maybePromise).catch((err: unknown) =>
            finish({ err, user: null }),
          );
        }
      } catch (err) {
        finish({ err, user: null });
      }
    });
  }

  // Bunest-native `AuthStrategy` implementing `validate(request, context)`
  try {
    const principal = await (strat as AuthStrategy).validate(
      req as Request,
      context,
    );
    return { err: null, user: principal };
  } catch (err) {
    return { err, user: null };
  }
}

function attachPrincipal(
  request: unknown,
  context: ExecutionContext,
  principal: unknown,
  property = "user",
): void {
  if (request && typeof request === "object") {
    // Attach to WeakMap store consumed by @CurrentUser(), RolesGuard, and PoliciesGuard
    setRequestUser(request, principal);

    // Also attach to request[property] for NestJS Passport parity (e.g. req.user / req[property])
    try {
      (request as Record<string, unknown>)[property] = principal;
    } catch {
      // Non-extensible / read-only request object; WeakMap & RequestContext still hold the user
    }
  }

  // Also attach to active RequestContext (`requestContext.user` / custom property) when available
  const reqCtx =
    (context as { requestContext?: Record<string, unknown> }).requestContext ??
    (getCurrentRequestContext() as Record<string, unknown> | undefined);
  if (reqCtx && typeof reqCtx === "object") {
    reqCtx[property] = principal;
    if (property !== "user") {
      reqCtx.user = principal;
    }
  }
}

const DEFAULT_AUTH_OPTIONS: Readonly<{ session: boolean; property: string }> = {
  session: false,
  property: "user",
};

const authGuardMixinCache = new Map<string, Type<IAuthGuard>>();

/**
 * Passport-style mixin guard factory returning a subclassable `IAuthGuard` class:
 * `@UseGuards(AuthGuard("jwt"))`, `@UseGuards(AuthGuard(["jwks-jwt", "api-key"]))`,
 * or `class JwtAuthGuard extends AuthGuard("jwt") { handleRequest(...) {} getRequest(...) {} }`.
 *
 * - Respects `@Public()` metadata on handler or controller.
 * - Supports `getRequest`, `handleRequest`, `getAuthenticateOptions`, and `logIn` overrides.
 * - Tries configured strategies in order; attaches the resolved principal to
 *   `request[property]`, `requestContext.user`, and `@CurrentUser()`.
 */
export function AuthGuard(type?: string | readonly string[]): Type<IAuthGuard> {
  const strategyList: readonly string[] | undefined =
    type === undefined
      ? undefined
      : Array.isArray(type)
        ? [...type]
        : [type as string];

  if (strategyList !== undefined) {
    if (strategyList.length === 0) {
      throw new Error("AuthGuard requires at least one strategy name");
    }
    for (const name of strategyList) {
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error("AuthGuard strategy names must be non-empty strings");
      }
    }
  }

  const cacheKey =
    strategyList === undefined ? "__default__" : JSON.stringify(strategyList);

  const cached = authGuardMixinCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  @Injectable()
  class MixinAuthGuard implements IAuthGuard {
    @Optional()
    @Inject(AuthModuleOptions)
    protected options: IAuthModuleOptions = {};

    private readonly reflectorInstance: Reflector;

    constructor(
      @Optional()
      @Inject(AuthStrategyRegistry)
      private readonly registry?: AuthStrategyRegistry,
      @Optional()
      @Inject(Reflector)
      reflector?: Reflector,
      @Optional()
      @Inject(AUTH_MODULE_OPTIONS)
      moduleOptions?: IAuthModuleOptions,
    ) {
      this.reflectorInstance = reflector ?? new Reflector();
      if (moduleOptions) {
        this.options = moduleOptions;
      }
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const isPublic = this.reflectorInstance.getAllAndOverride<boolean>(
        IS_PUBLIC_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (isPublic) {
        return true;
      }

      const authOptions = await this.getAuthenticateOptions(context);
      const mergedOptions: IAuthModuleOptions & Record<string, unknown> = {
        ...DEFAULT_AUTH_OPTIONS,
        ...(this.options ?? {}),
        ...(authOptions ?? {}),
      };
      const userProperty =
        mergedOptions.property || DEFAULT_AUTH_OPTIONS.property;

      const resolvedNames = this.resolveStrategyNames(mergedOptions);
      const req = this.getRequest(context);

      if (resolvedNames.length === 0) {
        const fallbackUser = this.handleRequest(
          new UnauthorizedException(
            "No authentication strategy configured for AuthGuard",
          ),
          null,
          undefined,
          context,
        );
        attachPrincipal(req, context, fallbackUser, userProperty);
        return true;
      }

      let lastError: unknown;
      let lastInfo: unknown;
      let lastStatus: number | undefined;
      let matchedUser: unknown;
      let authenticated = false;

      const {
        defaultStrategy: _defaultStrategy,
        property: _property,
        ...strategyOptions
      } = mergedOptions;

      for (const name of resolvedNames) {
        const strat =
          this.registry?.get(name) ?? defaultPassportInstance.getStrategy(name);
        if (!strat) {
          lastError = new UnauthorizedException(
            `Authentication strategy "${name}" is not registered`,
          );
          continue;
        }

        const outcome = await executeStrategy(
          strat,
          req,
          context,
          strategyOptions,
        );

        if (outcome.err) {
          lastError = outcome.err;
          lastInfo = outcome.info ?? lastInfo;
          lastStatus = outcome.status ?? lastStatus;
          continue;
        }

        if (
          outcome.user !== null &&
          outcome.user !== undefined &&
          outcome.user !== false
        ) {
          matchedUser = outcome.user;
          lastInfo = outcome.info;
          lastStatus = outcome.status;
          authenticated = true;
          break;
        }

        lastInfo = outcome.info ?? lastInfo;
        lastStatus = outcome.status ?? lastStatus;
      }

      if (req && typeof req === "object" && lastInfo !== undefined) {
        try {
          (req as Record<string, unknown>).authInfo = lastInfo;
        } catch {
          // ignore non-extensible request
        }
      }

      const finalUser = this.handleRequest(
        authenticated ? null : (lastError ?? null),
        authenticated ? matchedUser : false,
        lastInfo,
        context,
        lastStatus,
      );

      attachPrincipal(req, context, finalUser, userProperty);
      return true;
    }

    getRequest(context: ExecutionContext): any {
      return context.switchToHttp().getRequest();
    }

    getResponse(context: ExecutionContext): any {
      return context.switchToHttp().getResponse();
    }

    async logIn<TRequest extends { logIn: Function } = any>(
      request: TRequest,
    ): Promise<void> {
      const property = this.options?.property || DEFAULT_AUTH_OPTIONS.property;
      const reqObj = request as unknown as Record<string, unknown>;
      const user =
        reqObj?.[property] ??
        (reqObj && typeof reqObj === "object"
          ? getRequestUser(reqObj)
          : undefined);

      if (reqObj && typeof reqObj.logIn === "function") {
        await new Promise<void>((resolve, reject) =>
          (
            reqObj.logIn as (
              u: unknown,
              opts: IAuthModuleOptions,
              cb: (err?: unknown) => void,
            ) => void
          )(user, this.options, (err?: unknown) =>
            err ? reject(err) : resolve(),
          ),
        );
        return;
      }

      if (defaultPassportInstance.hasSerializers() && user !== undefined) {
        const serialized = await defaultPassportInstance.serialize(user);
        if (reqObj && typeof reqObj === "object") {
          try {
            const existingSession =
              reqObj.session && typeof reqObj.session === "object"
                ? (reqObj.session as Record<string, unknown>)
                : {};
            reqObj.session = {
              ...existingSession,
              passport: { user: serialized },
            };
          } catch {
            // ignore non-extensible request
          }
        }
      }
    }

    handleRequest<TUser = any>(
      err: unknown,
      user: unknown,
      _info: unknown,
      _context: ExecutionContext,
      _status?: unknown,
    ): TUser {
      if (err || !user) {
        throw err || new UnauthorizedException("Authentication failed");
      }
      return user as TUser;
    }

    getAuthenticateOptions(
      _context: ExecutionContext,
    ):
      | Promise<AuthGuardAuthenticateOptions>
      | AuthGuardAuthenticateOptions
      | undefined {
      return undefined;
    }

    private resolveStrategyNames(
      mergedOptions: IAuthModuleOptions,
    ): readonly string[] {
      if (strategyList !== undefined) {
        return strategyList;
      }
      const fromRegistry = this.registry?.getDefaultStrategy();
      if (fromRegistry) {
        return Array.isArray(fromRegistry) ? fromRegistry : [fromRegistry];
      }
      const fromOpts = mergedOptions.defaultStrategy;
      if (fromOpts) {
        return Array.isArray(fromOpts) ? fromOpts : [fromOpts];
      }
      return [];
    }
  }

  Object.defineProperty(MixinAuthGuard, "name", {
    value: `AuthGuard(${strategyList ? strategyList.join(",") : "default"})`,
  });

  authGuardMixinCache.set(cacheKey, MixinAuthGuard);
  return MixinAuthGuard;
}

// ============================================================================
// Built-In Ready-to-Use Strategies
// ============================================================================

export interface JwtAuthStrategyOptions {
  name?: string;
  extractToken?: TokenExtractor;
  cookieName?: string;
  verifyOptions?: JwtVerifyOptions;
  validate?: (
    payload: JwtPayload,
    request: Request,
    context: ExecutionContext,
  ) => unknown | Promise<unknown>;
}

/**
 * Built-in strategy verifying Bearer/cookie JWTs with `JwtService`.
 * Default strategy name: `"jwt"`.
 */
@Injectable()
export class JwtAuthStrategy implements AuthStrategy {
  public readonly name: string;

  constructor(
    private readonly jwtService: JwtService,
    @Optional()
    @Inject(JWT_AUTH_STRATEGY_OPTIONS)
    private readonly options?: JwtAuthStrategyOptions,
  ) {
    this.name = options?.name ?? "jwt";
  }

  async validate(
    request: Request,
    context: ExecutionContext,
  ): Promise<unknown> {
    let token: string | null | undefined;
    if (this.options?.extractToken) {
      token = this.options.extractToken(request, context);
    } else {
      token = extractBearerToken(request);
      if (!token && this.options?.cookieName) {
        token = extractCookieToken(this.options.cookieName)(request, context);
      }
    }

    if (!token) {
      return null;
    }

    const payload = await this.jwtService.verify(
      token,
      this.options?.verifyOptions,
    );

    if (this.options?.validate) {
      return await this.options.validate(payload, request, context);
    }
    return payload;
  }
}

export interface JwksJwtAuthStrategyOptions {
  name?: string;
  extractToken?: TokenExtractor;
  cookieName?: string;
  verifyOptions?: JwksVerifyOptions;
  validate?: (
    payload: JwtPayload,
    request: Request,
    context: ExecutionContext,
  ) => unknown | Promise<unknown>;
}

/**
 * Built-in strategy verifying asymmetric Bearer/cookie JWTs against a remote
 * or cached JWKS endpoint via `JwksClient`.
 * Default strategy name: `"jwks-jwt"`.
 */
@Injectable()
export class JwksJwtAuthStrategy implements AuthStrategy {
  public readonly name: string;

  constructor(
    private readonly jwksClient: JwksClient,
    @Optional()
    @Inject(JWKS_JWT_AUTH_STRATEGY_OPTIONS)
    private readonly options?: JwksJwtAuthStrategyOptions,
  ) {
    this.name = options?.name ?? "jwks-jwt";
  }

  async validate(
    request: Request,
    context: ExecutionContext,
  ): Promise<unknown> {
    let token: string | null | undefined;
    if (this.options?.extractToken) {
      token = this.options.extractToken(request, context);
    } else {
      token = extractBearerToken(request);
      if (!token && this.options?.cookieName) {
        token = extractCookieToken(this.options.cookieName)(request, context);
      }
    }

    if (!token) {
      return null;
    }

    const payload = await this.jwksClient.verifyJwtWithJwks(
      token,
      this.options?.verifyOptions,
    );

    if (this.options?.validate) {
      return await this.options.validate(payload, request, context);
    }
    return payload;
  }
}

export interface ApiKeyRecord {
  readonly key: string;
  readonly principal?: unknown;
}

export interface ApiKeyAuthStrategyOptions {
  name?: string;
  /** Header name carrying the API key. Default: `"x-api-key"`. */
  headerName?: string;
  /** Optional query parameter fallback (disabled by default). */
  queryParam?: string;
  /** Custom extractor overriding header/query extraction. */
  extractKey?: (
    request: Request,
    context: ExecutionContext,
  ) => string | null | undefined;
  /** Static allowlist of API keys (compared in constant time across all entries). */
  keys?: ReadonlyArray<string | ApiKeyRecord>;
  /** Optional custom validation / principal resolver callback. */
  validate?: (
    apiKey: string,
    request: Request,
    context: ExecutionContext,
  ) => unknown | Promise<unknown>;
}

/**
 * Built-in API key authentication strategy using constant-time key comparison
 * (`timingSafeEqualString`) without early-exit timing leaks.
 * Default strategy name: `"api-key"`.
 */
@Injectable()
export class ApiKeyAuthStrategy implements AuthStrategy {
  public readonly name: string;
  private readonly headerName: string;
  private readonly normalizedKeys?: readonly ApiKeyRecord[];

  constructor(
    @Optional()
    @Inject(API_KEY_AUTH_STRATEGY_OPTIONS)
    private readonly options: ApiKeyAuthStrategyOptions = {},
  ) {
    this.name = options.name ?? "api-key";
    this.headerName = (options.headerName ?? "x-api-key").toLowerCase();
    if (options.keys) {
      this.normalizedKeys = options.keys.map((entry) =>
        typeof entry === "string" ? { key: entry } : entry,
      );
    }
  }

  async validate(
    request: Request,
    context: ExecutionContext,
  ): Promise<unknown> {
    let providedKey: string | null | undefined;
    if (this.options.extractKey) {
      providedKey = this.options.extractKey(request, context);
    } else {
      providedKey = request.headers.get(this.headerName)?.trim() || null;
      if (!providedKey && this.options.queryParam) {
        const url = new URL(request.url);
        providedKey =
          url.searchParams.get(this.options.queryParam)?.trim() || null;
      }
    }

    if (!providedKey) {
      return null;
    }

    if (this.normalizedKeys) {
      // Iterate all keys without short-circuiting to prevent timing side-channels
      let matchedRecord: ApiKeyRecord | undefined;
      for (const candidate of this.normalizedKeys) {
        if (timingSafeEqualString(providedKey, candidate.key)) {
          matchedRecord = candidate;
        }
      }

      if (!matchedRecord) {
        throw new UnauthorizedException("Invalid API key");
      }

      if (this.options.validate) {
        return await this.options.validate(providedKey, request, context);
      }

      return (
        matchedRecord.principal ?? {
          authType: "api-key",
          authenticated: true,
        }
      );
    }

    if (this.options.validate) {
      const principal = await this.options.validate(
        providedKey,
        request,
        context,
      );
      if (
        principal === null ||
        principal === undefined ||
        principal === false
      ) {
        throw new UnauthorizedException("Invalid API key");
      }
      return principal;
    }

    throw new UnauthorizedException(
      "ApiKeyAuthStrategy requires either keys or validate option",
    );
  }
}

export interface BasicAuthUser {
  readonly username: string;
  readonly password: string;
  readonly principal?: unknown;
}

export interface BasicAuthStrategyOptions {
  name?: string;
  /** Static credentials list or `{ username: password }` map checked in constant time. */
  users?: ReadonlyArray<BasicAuthUser> | Record<string, string>;
  /** Custom validator callback (receives decoded username and password). */
  validate?: (
    username: string,
    password: string,
    request: Request,
    context: ExecutionContext,
  ) => unknown | Promise<unknown>;
}

/**
 * Built-in HTTP Basic Authentication strategy (RFC 7617) using constant-time
 * username and password checks without early-exit side channels.
 * Default strategy name: `"basic"`.
 */
@Injectable()
export class BasicAuthStrategy implements AuthStrategy {
  public readonly name: string;
  private readonly normalizedUsers?: readonly BasicAuthUser[];

  constructor(
    @Optional()
    @Inject(BASIC_AUTH_STRATEGY_OPTIONS)
    private readonly options: BasicAuthStrategyOptions = {},
  ) {
    this.name = options.name ?? "basic";
    if (options.users) {
      this.normalizedUsers = Array.isArray(options.users)
        ? [...options.users]
        : Object.entries(options.users).map(([username, password]) => ({
            username,
            password,
          }));
    }
  }

  async validate(
    request: Request,
    context: ExecutionContext,
  ): Promise<unknown> {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
      return null;
    }

    const spaceIdx = authHeader.indexOf(" ");
    if (spaceIdx === -1) {
      return null;
    }

    const scheme = authHeader.slice(0, spaceIdx);
    if (scheme.toLowerCase() !== "basic") {
      return null;
    }

    const encoded = authHeader.slice(spaceIdx + 1).trim();
    if (
      encoded.length === 0 ||
      encoded.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) {
      throw new UnauthorizedException("Malformed Basic authorization header");
    }

    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) {
      throw new UnauthorizedException(
        "Malformed Basic authorization credentials",
      );
    }

    const username = decoded.slice(0, colonIdx);
    const password = decoded.slice(colonIdx + 1);

    if (this.normalizedUsers) {
      // Constant-time evaluation of BOTH username and password across all entries
      let matchedUser: BasicAuthUser | undefined;
      for (const entry of this.normalizedUsers) {
        const userOk = timingSafeEqualString(username, entry.username);
        const passOk = timingSafeEqualString(password, entry.password);
        if ((Number(userOk) & Number(passOk)) === 1) {
          matchedUser = entry;
        }
      }

      if (!matchedUser) {
        throw new UnauthorizedException("Invalid Basic credentials");
      }

      if (this.options.validate) {
        return await this.options.validate(
          username,
          password,
          request,
          context,
        );
      }

      return matchedUser.principal ?? { username: matchedUser.username };
    }

    if (this.options.validate) {
      const principal = await this.options.validate(
        username,
        password,
        request,
        context,
      );
      if (
        principal === null ||
        principal === undefined ||
        principal === false
      ) {
        throw new UnauthorizedException("Invalid Basic credentials");
      }
      return principal;
    }

    throw new UnauthorizedException(
      "BasicAuthStrategy requires either users or validate option",
    );
  }
}

// ============================================================================
// AuthModule & PassportModule
// ============================================================================

function isStrategyClass(
  entry: AuthStrategyRegistration,
): entry is Type<AuthStrategy> {
  return typeof entry === "function";
}

@Module({})
export class AuthModule {
  static register(options: IAuthModuleOptions = {}): DynamicModule {
    const strategies = options.strategies ?? [];
    const strategyClasses: Type<AuthStrategy>[] = [];
    const classIndexMap = new Map<number, number>();

    strategies.forEach((entry, idx) => {
      if (isStrategyClass(entry)) {
        classIndexMap.set(idx, strategyClasses.length);
        strategyClasses.push(entry);
      }
    });

    const providers: Provider[] = [
      { provide: AUTH_MODULE_OPTIONS, useValue: options },
      { provide: AuthModuleOptions, useValue: options },
      ...strategyClasses,
      {
        provide: AuthStrategyRegistry,
        inject: strategyClasses,
        useFactory: (...resolvedClasses: AuthStrategy[]) => {
          const registry = new AuthStrategyRegistry();
          strategies.forEach((entry, idx) => {
            const resolvedIdx = classIndexMap.get(idx);
            const strategy =
              resolvedIdx !== undefined
                ? resolvedClasses[resolvedIdx]!
                : (entry as AuthStrategy);
            registry.register(strategy);
          });
          if (options.defaultStrategy) {
            registry.setDefaultStrategy(options.defaultStrategy);
          }
          return registry;
        },
      },
    ];

    return {
      module: AuthModule,
      global: options.global,
      imports: options.imports,
      providers,
      exports: [
        AuthStrategyRegistry,
        AUTH_MODULE_OPTIONS,
        AuthModuleOptions,
        ...strategyClasses,
      ],
    };
  }

  static registerAsync(options: AuthModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);

    return {
      module: AuthModule,
      global: options.global,
      imports: options.imports,
      providers: [
        ...asyncProviders,
        { provide: AuthModuleOptions, useExisting: AUTH_MODULE_OPTIONS },
        {
          provide: AuthStrategyRegistry,
          inject: [AUTH_MODULE_OPTIONS, { token: ModuleRef, optional: true }],
          useFactory: async (
            resolvedOptions: IAuthModuleOptions = {},
            moduleRef?: ModuleRef,
          ) => {
            const registry = new AuthStrategyRegistry();
            for (const entry of resolvedOptions.strategies ?? []) {
              if (isStrategyClass(entry)) {
                const instance = moduleRef
                  ? await moduleRef
                      .resolve(entry, undefined, { strict: false })
                      .catch(() => moduleRef.create(entry))
                  : new entry();
                registry.register(instance);
              } else {
                registry.register(entry);
              }
            }
            if (resolvedOptions.defaultStrategy) {
              registry.setDefaultStrategy(resolvedOptions.defaultStrategy);
            }
            return registry;
          },
        },
      ],
      exports: [AuthStrategyRegistry, AUTH_MODULE_OPTIONS, AuthModuleOptions],
    };
  }

  private static createAsyncProviders(
    options: AuthModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    if (options.useClass) {
      return [
        this.createAsyncOptionsProvider(options),
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
      ];
    }
    throw new Error(
      "AuthModule.registerAsync requires one of useFactory, useClass, or useExisting",
    );
  }

  private static createAsyncOptionsProvider(
    options: AuthModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: AUTH_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      };
    }
    const injectToken = options.useExisting ?? options.useClass;
    if (!injectToken) {
      throw new Error(
        "AuthModule.registerAsync requires one of useFactory, useClass, or useExisting",
      );
    }
    return {
      provide: AUTH_MODULE_OPTIONS,
      useFactory: async (optionsFactory: AuthOptionsFactory) =>
        await optionsFactory.createAuthOptions(),
      inject: [injectToken],
    };
  }
}

/**
 * NestJS `@nestjs/passport`-compatible module facade over `AuthModule`
 * with zero external `passport` npm dependency.
 */
@Module({})
export class PassportModule {
  static register(options: IAuthModuleOptions = {}): DynamicModule {
    const dyn = AuthModule.register(options);
    return {
      ...dyn,
      module: PassportModule,
    };
  }

  static registerAsync(options: AuthModuleAsyncOptions): DynamicModule {
    const dyn = AuthModule.registerAsync(options);
    return {
      ...dyn,
      module: PassportModule,
    };
  }
}
