import {
  Logger,
  type CanActivate,
  type ExceptionFilter,
  type ExceptionFilterLike,
  type GuardLike,
  type InterceptorLike,
  type NestInterceptor,
  type PipeLike,
  type PipeTransform,
  type PreRequestHook,
  type RouteConflictPolicy,
  type RouteResolutionStrategy,
  type VersioningOptions,
  type WebSocketAdapter,
} from "../common/index";
import type { CookieSigner, GlobalPrefixOptions } from "../http/index";
import type { InstanceWrapper } from "../discovery/discovery.service";

function describeEnhancerValue(value: unknown): string {
  if (typeof value === "function") {
    return `class ${value.name || "anonymous"}`;
  }
  if (
    value instanceof Promise ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as { then?: unknown }).then === "function")
  ) {
    return "a promise";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object" && value !== null) {
    return "an object";
  }
  return String(value);
}

function hasEnhancerMethod(value: unknown, method: string): boolean {
  if (
    value === null ||
    value === undefined ||
    Array.isArray(value) ||
    value instanceof Promise
  ) {
    return false;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  return typeof (value as Record<string, unknown>)[method] === "function";
}

/**
 * Centralized application configuration container matching NestJS v12 `ApplicationConfig`
 * (36/36 public members).
 */
export class ApplicationConfig {
  private readonly logger = new Logger("ApplicationConfig");
  private globalPrefix = "";
  private globalPrefixOptions: GlobalPrefixOptions = {};
  private globalPipes: PipeLike[] = [];
  private globalFilters: ExceptionFilterLike[] = [];
  private globalInterceptors: InterceptorLike[] = [];
  private globalGuards: GuardLike[] = [];
  private readonly globalRequestPipes: InstanceWrapper<PipeTransform>[] = [];
  private readonly globalRequestFilters: InstanceWrapper<ExceptionFilter>[] =
    [];
  private readonly globalRequestInterceptors: InstanceWrapper<NestInterceptor>[] =
    [];
  private readonly globalRequestGuards: InstanceWrapper<CanActivate>[] = [];
  private readonly globalPreRequestHooks: PreRequestHook[] = [];
  private versioningOptions?: VersioningOptions;
  private ioAdapter: WebSocketAdapter | null;
  private cookieSigner?: CookieSigner;
  private routeConflictPolicy?: RouteConflictPolicy;
  private routeResolutionStrategy?: RouteResolutionStrategy;

  constructor(ioAdapter: WebSocketAdapter | null = null) {
    this.ioAdapter = ioAdapter ?? null;
  }

  setGlobalPrefix(prefix: string): void {
    this.globalPrefix = prefix;
  }

  getGlobalPrefix(): string {
    return this.globalPrefix;
  }

  setGlobalPrefixOptions(options: GlobalPrefixOptions): void {
    this.globalPrefixOptions = options;
  }

  getGlobalPrefixOptions(): GlobalPrefixOptions {
    return this.globalPrefixOptions;
  }

  setIoAdapter(ioAdapter: WebSocketAdapter): void {
    this.ioAdapter = ioAdapter;
  }

  getIoAdapter(): WebSocketAdapter | null {
    return this.ioAdapter ?? null;
  }

  addGlobalPipe(pipe: PipeLike): void {
    this.globalPipes.push(pipe);
  }

  useGlobalPipes(...pipes: PipeLike[]): void {
    for (const pipe of pipes) {
      if (!hasEnhancerMethod(pipe, "transform")) {
        throw new Error(
          `The pipe (${describeEnhancerValue(pipe)}) doesn't provide the "transform" method.`,
        );
      }
    }
    this.globalPipes = this.globalPipes.concat(pipes);
  }

  getGlobalPipes(): readonly PipeLike[] {
    return [...this.globalPipes];
  }

  addGlobalRequestPipe(wrapper: InstanceWrapper<PipeTransform>): void {
    this.globalRequestPipes.push(wrapper);
  }

  getGlobalRequestPipes(): InstanceWrapper<PipeTransform>[] {
    return [...this.globalRequestPipes];
  }

  addGlobalFilter(filter: ExceptionFilterLike): void {
    this.globalFilters.push(filter);
  }

  useGlobalFilters(...filters: ExceptionFilterLike[]): void {
    for (const filter of filters) {
      if (!hasEnhancerMethod(filter, "catch")) {
        this.logger.warn(
          `The exception filter (${describeEnhancerValue(filter)}) doesn't provide the "catch" method.`,
        );
      }
    }
    this.globalFilters = this.globalFilters.concat(filters);
  }

  getGlobalFilters(): readonly ExceptionFilterLike[] {
    return [...this.globalFilters];
  }

  addGlobalRequestFilter(wrapper: InstanceWrapper<ExceptionFilter>): void {
    this.globalRequestFilters.push(wrapper);
  }

  getGlobalRequestFilters(): InstanceWrapper<ExceptionFilter>[] {
    return [...this.globalRequestFilters];
  }

  addGlobalInterceptor(interceptor: InterceptorLike): void {
    this.globalInterceptors.push(interceptor);
  }

  useGlobalInterceptors(...interceptors: InterceptorLike[]): void {
    for (const interceptor of interceptors) {
      if (!hasEnhancerMethod(interceptor, "intercept")) {
        throw new Error(
          `The interceptor (${describeEnhancerValue(interceptor)}) doesn't provide the "intercept" method.`,
        );
      }
    }
    this.globalInterceptors = this.globalInterceptors.concat(interceptors);
  }

  getGlobalInterceptors(): readonly InterceptorLike[] {
    return [...this.globalInterceptors];
  }

  addGlobalRequestInterceptor(wrapper: InstanceWrapper<NestInterceptor>): void {
    this.globalRequestInterceptors.push(wrapper);
  }

  getGlobalRequestInterceptors(): InstanceWrapper<NestInterceptor>[] {
    return [...this.globalRequestInterceptors];
  }

  addGlobalGuard(guard: GuardLike): void {
    this.globalGuards.push(guard);
  }

  useGlobalGuards(...guards: GuardLike[]): void {
    for (const guard of guards) {
      if (!hasEnhancerMethod(guard, "canActivate")) {
        throw new Error(
          `The guard (${describeEnhancerValue(guard)}) doesn't provide the "canActivate" method.`,
        );
      }
    }
    this.globalGuards = this.globalGuards.concat(guards);
  }

  getGlobalGuards(): readonly GuardLike[] {
    return [...this.globalGuards];
  }

  addGlobalRequestGuard(wrapper: InstanceWrapper<CanActivate>): void {
    this.globalRequestGuards.push(wrapper);
  }

  getGlobalRequestGuards(): InstanceWrapper<CanActivate>[] {
    return [...this.globalRequestGuards];
  }

  enableVersioning(options: VersioningOptions): void {
    if (Array.isArray(options.defaultVersion)) {
      this.versioningOptions = {
        ...options,
        defaultVersion: [...new Set(options.defaultVersion)],
      };
      return;
    }
    this.versioningOptions = options;
  }

  getVersioning(): VersioningOptions | undefined {
    return this.versioningOptions;
  }

  setCookieSigner(signer: CookieSigner | undefined): void {
    this.cookieSigner = signer;
  }

  getCookieSigner(): CookieSigner | undefined {
    return this.cookieSigner;
  }

  registerPreRequestHook(...hooks: PreRequestHook[]): void {
    this.globalPreRequestHooks.push(...hooks);
  }

  getGlobalPreRequestHooks(): PreRequestHook[] {
    return [...this.globalPreRequestHooks];
  }

  setRouteConflictPolicy(policy: RouteConflictPolicy | undefined): void {
    this.routeConflictPolicy = policy;
  }

  getRouteConflictPolicy(): RouteConflictPolicy | undefined {
    return this.routeConflictPolicy;
  }

  setRouteResolutionStrategy(
    strategy: RouteResolutionStrategy | undefined,
  ): void {
    this.routeResolutionStrategy = strategy;
  }

  getRouteResolutionStrategy(): RouteResolutionStrategy | undefined {
    return this.routeResolutionStrategy;
  }
}
