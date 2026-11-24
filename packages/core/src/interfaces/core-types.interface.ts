import type {
  BunestApplicationOptions,
  BunestMiddleware,
  ContextId,
  DynamicModule,
  FactoryDependency,
  ForwardReference,
  InjectionToken,
  IntrospectionResult,
  MiddlewareFunction,
  ModuleMetadata,
  Provider,
  RequestMethod,
  RouteInfo,
  Scope,
  ShutdownSignal,
  Type,
  VersionValue,
} from "../common/index";

export type { ContextId };

/**
 * Lightweight zero-RxJS subscribable contract (ADR-008) matching NestJS
 * `.subscribe(...)` ergonomics without adding an `rxjs` dependency.
 */
export interface Unsubscribable {
  unsubscribe(): void;
}

export interface SubscribableObserver<T> {
  next?: (value: T) => void;
  error?: (err: unknown) => void;
  complete?: () => void;
}

export interface Subscribable<T> {
  subscribe(
    observerOrNext?: SubscribableObserver<T> | ((value: T) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Unsubscribable;
}

/**
 * Entry (root) module accepted by `BunestFactory` / `NestFactory` (NestJS v12.5.1 parity),
 * including plain `ModuleMetadata` shorthand (`{ controllers: [...] }`).
 */
export type IEntryNestModule =
  | Type<any>
  | DynamicModule
  | ForwardReference
  | ModuleMetadata
  | Promise<Type<any> | DynamicModule | ForwardReference | ModuleMetadata>;

export type ModuleRefGetOrResolveOpts = ModuleRefGetOptions;

export type ShutdownSignalInput = ShutdownSignal | NodeJS.Signals | string;

export interface LifecycleModuleGroupLike {
  readonly module: { readonly id: string; readonly name: string };
  readonly instances: readonly object[];
}

/**
 * Narrow structural interface for `LifecycleManager`, keeping
 * `core-types.interface.ts` strictly acyclic (zero type-only or runtime cycles).
 */
export interface LifecycleManagerLike {
  callModuleInit(groups: readonly LifecycleModuleGroupLike[]): Promise<void>;
  callModuleInitFor?(
    groups: readonly LifecycleModuleGroupLike[],
  ): Promise<void>;
  callApplicationBootstrap(
    groups: readonly LifecycleModuleGroupLike[],
  ): Promise<void>;
  callShutdown(
    groups: readonly LifecycleModuleGroupLike[],
    signal?: ShutdownSignalInput,
    stopServer?: () => Promise<void> | void,
  ): Promise<void>;
  enableShutdownHooks(
    signals: readonly ShutdownSignalInput[] | undefined,
    onSignal: (signal: NodeJS.Signals) => Promise<void> | void,
  ): void;
  cleanupShutdownHooks(): void;
  getActiveHookCount(): number;
  getIsInitialized(): boolean;
  getIsClosed(): boolean;
}

declare module "../common/index" {
  interface BunestApplicationOptions {
    bufferLogs?: boolean;
    autoFlushLogs?: boolean;
    lifecycleManager?: LifecycleManagerLike;
  }
}

export interface BunestApplicationContextOptions extends BunestApplicationOptions {
  bufferLogs?: boolean;
  autoFlushLogs?: boolean;
  lifecycleManager?: LifecycleManagerLike;
}

export type ProviderKind = "class" | "value" | "factory" | "existing";

export interface NormalizedProvider<T = unknown> {
  readonly token: InjectionToken<T>;
  readonly kind: ProviderKind;
  readonly scope: Scope;
  readonly durable?: boolean;
  readonly useClass?: Type<T>;
  readonly useValue?: T;
  readonly useFactory?: (...args: unknown[]) => T | Promise<T>;
  readonly inject?: readonly FactoryDependency[];
  readonly useExisting?: InjectionToken<T>;
  readonly isMulti?: boolean;
}

export const ENHANCER_OVERRIDE_MARKER = Symbol.for("bunest:enhancer-override");

export type EnhancerKind = "guard" | "pipe" | "interceptor" | "filter";

export type MockFactory = (token: InjectionToken) => unknown;

export interface EnhancerValueOverrideEntry {
  readonly [ENHANCER_OVERRIDE_MARKER]: true;
  readonly kind: "value";
  readonly value: unknown;
}

export interface EnhancerClassOverrideEntry {
  readonly [ENHANCER_OVERRIDE_MARKER]: true;
  readonly kind: "class";
  readonly useClass: Type<unknown>;
  readonly scope?: Scope;
}

export interface EnhancerFactoryOverrideEntry {
  readonly [ENHANCER_OVERRIDE_MARKER]: true;
  readonly kind: "factory";
  readonly factory: (...args: any[]) => unknown | Promise<unknown>;
  readonly inject?: readonly FactoryDependency[];
  readonly scope?: Scope;
}

export interface EnhancerExistingOverrideEntry {
  readonly [ENHANCER_OVERRIDE_MARKER]: true;
  readonly kind: "existing";
  readonly useExisting: InjectionToken;
}

export type EnhancerOverrideEntry =
  | EnhancerValueOverrideEntry
  | EnhancerClassOverrideEntry
  | EnhancerFactoryOverrideEntry
  | EnhancerExistingOverrideEntry;

export function isEnhancerOverrideEntry(
  v: unknown,
): v is EnhancerOverrideEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<PropertyKey, unknown>)[ENHANCER_OVERRIDE_MARKER] === true
  );
}

export type EnhancerOverrideValue =
  Type<unknown> | object | EnhancerOverrideEntry;

export function isContextId(value: unknown): value is ContextId {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    (typeof (value as ContextId).id === "number" ||
      typeof (value as ContextId).id === "symbol") &&
    typeof (value as Partial<RequestScopeContainer>).resolve !== "function"
  );
}

export type InjectBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream
  | URLSearchParams
  | FormData
  | null;

export interface InjectOptions {
  method?: string;
  url: string;
  headers?: Record<string, string | string[]>;
  query?: Record<
    string,
    | string
    | number
    | boolean
    | readonly (string | number | boolean)[]
    | undefined
  >;
  payload?: unknown;
  body?: InjectBody;
  cookies?: Record<string, string>;
}

export interface InjectResponse {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Record<string, string | string[]>;
  readonly body: string;
  readonly rawPayload: Uint8Array;
  readonly raw: Response;
  json<T = unknown>(): T;
}

/**
 * Structural contract matching `@bunest/core/http`'s `RequestScopeContainer`.
 */
export interface RequestScopeContainer {
  resolve<T = unknown>(token: InjectionToken<T>): Promise<T> | T;
  registerRequestValue<T = unknown>(token: InjectionToken<T>, value: T): void;
  destroy(): Promise<void>;
}

export interface MiddlewareConfigEntry {
  readonly middleware:
    MiddlewareFunction | Type<BunestMiddleware> | BunestMiddleware;
  readonly include?: RouteInfo[];
  readonly exclude?: RouteInfo[];
  readonly moduleId: string;
}

export interface ContainerOverrides {
  providers?: Map<InjectionToken, Provider>;
  guards?: Map<Type<unknown>, EnhancerOverrideValue>;
  pipes?: Map<Type<unknown>, EnhancerOverrideValue>;
  interceptors?: Map<Type<unknown>, EnhancerOverrideValue>;
  filters?: Map<Type<unknown>, EnhancerOverrideValue>;
  modules?: Map<Type<unknown> | DynamicModule, Type<unknown> | DynamicModule>;
  mocker?: MockFactory;
}

export interface ModuleRefGetOptions {
  strict?: boolean;
  each?: boolean;
}

/**
 * Internal host interface implemented by DIContainer and consumed by ModuleRef
 * (keeps module-ref.ts strictly acyclic with di-container.ts).
 */
export interface ModuleRefHost {
  getSync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    options?: { strict?: boolean; each?: false },
  ): T;
  getSync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    options: { strict?: boolean; each: true },
  ): T[];
  getSync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    options?: ModuleRefGetOptions,
  ): T | T[];

  resolveAsync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
    options?: { strict?: boolean; each?: false },
  ): Promise<T>;
  resolveAsync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    contextIdOrContainer: ContextId | RequestScopeContainer | undefined,
    options: { strict?: boolean; each: true },
  ): Promise<T[]>;
  resolveAsync<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
    options?: ModuleRefGetOptions,
  ): Promise<T | T[]>;

  createInstance<T = unknown>(
    type: Type<T>,
    moduleId: string,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
  ): Promise<T>;

  introspectToken<T = unknown>(
    token: InjectionToken<T>,
    moduleId: string,
  ): IntrospectionResult;

  registerRequestByContextId<T = unknown>(
    request: T,
    contextId: ContextId,
  ): void;
}

/**
 * NestJS v12 route conflict / resolution compatibility types.
 */
export type ConflictKind = "duplicate" | "shadow";

export type ResolvedRouteHandler = (...args: unknown[]) => unknown;

export interface ResolvedRoute {
  readonly method: RequestMethod | string;
  readonly path: string;
  readonly rawPath?: string;
  readonly host?: string | RegExp | Array<string | RegExp>;
  readonly version?: VersionValue;
  readonly methodVersion?: VersionValue;
  readonly controllerVersion?: VersionValue;
  readonly handler: ResolvedRouteHandler;
  readonly targetCallback?: (...args: unknown[]) => unknown;
  readonly methodName: string;
  readonly instanceWrapper?: unknown;
}

export interface RouteConflict {
  readonly winner: ResolvedRoute;
  readonly shadowed: ResolvedRoute;
  readonly kind: ConflictKind;
}

export interface RouteResolutionOptions {
  readonly onRouteResolved?: (route: ResolvedRoute) => void;
  readonly deferRegistration?: boolean;
}
