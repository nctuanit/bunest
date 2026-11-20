import type {
  CanActivate,
  ExceptionFilter,
  ExceptionFilterLike,
  GuardLike,
  InterceptorLike,
  NestInterceptor,
  PipeLike,
  PipeTransform,
  PreRequestHook,
  RouteConflictPolicy,
  RouteResolutionStrategy,
  VersioningOptions,
  WebSocketAdapter,
} from "@bunest/common";
import type { CookieSigner, GlobalPrefixOptions } from "@bunest/http";
import type { InstanceWrapper } from "../discovery/discovery.service";

/**
 * Centralized application configuration container matching NestJS v12 `ApplicationConfig`
 * (36/36 public members).
 */
export class ApplicationConfig {
  private globalPrefix = "";
  private globalPrefixOptions: GlobalPrefixOptions = {};
  private globalPipes: PipeLike[] = [];
  private globalFilters: ExceptionFilterLike[] = [];
  private globalInterceptors: InterceptorLike[] = [];
  private globalGuards: GuardLike[] = [];
  private readonly globalRequestPipes: InstanceWrapper<PipeTransform>[] = [];
  private readonly globalRequestFilters: InstanceWrapper<ExceptionFilter>[] = [];
  private readonly globalRequestInterceptors: InstanceWrapper<NestInterceptor>[] = [];
  private readonly globalRequestGuards: InstanceWrapper<CanActivate>[] = [];
  private readonly globalPreRequestHooks: PreRequestHook[] = [];
  private versioningOptions?: VersioningOptions;
  private ioAdapter?: WebSocketAdapter | null;
  private cookieSigner?: CookieSigner;
  private routeConflictPolicy?: RouteConflictPolicy;
  private routeResolutionStrategy?: RouteResolutionStrategy;

  constructor(ioAdapter?: WebSocketAdapter | null) {
    this.ioAdapter = ioAdapter ?? undefined;
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

  getIoAdapter(): WebSocketAdapter | undefined {
    return this.ioAdapter ?? undefined;
  }

  addGlobalPipe(pipe: PipeLike): void {
    this.globalPipes.push(pipe);
  }

  useGlobalPipes(...pipes: PipeLike[]): void {
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
    this.globalInterceptors = this.globalInterceptors.concat(interceptors);
  }

  getGlobalInterceptors(): readonly InterceptorLike[] {
    return [...this.globalInterceptors];
  }

  addGlobalRequestInterceptor(
    wrapper: InstanceWrapper<NestInterceptor>,
  ): void {
    this.globalRequestInterceptors.push(wrapper);
  }

  getGlobalRequestInterceptors(): InstanceWrapper<NestInterceptor>[] {
    return [...this.globalRequestInterceptors];
  }

  addGlobalGuard(guard: GuardLike): void {
    this.globalGuards.push(guard);
  }

  useGlobalGuards(...guards: GuardLike[]): void {
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
