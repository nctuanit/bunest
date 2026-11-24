import type {
  ExecutionContext,
  FactoryDependency,
  ModuleMetadata,
  OnModuleDestroy,
  Type,
} from "@bunest/core";

export const THROTTLER_OPTIONS = Symbol.for(
  "bunest:security:throttler_options",
);
export const THROTTLER_STORAGE = Symbol.for(
  "bunest:security:throttler_storage",
);
export const THROTTLE_METADATA = Symbol.for("bunest:security:throttle");
export const SKIP_THROTTLE_METADATA = Symbol.for(
  "bunest:security:skip_throttle",
);

export const getOptionsToken = (): symbol => THROTTLER_OPTIONS;
export const getStorageToken = (): symbol => THROTTLER_STORAGE;

export type Resolvable<T extends number | string | boolean> =
  T | ((context: ExecutionContext) => T | Promise<T>);

export type ThrottlerGetTrackerFunction = (
  req: any,
  context: ExecutionContext,
) => Promise<string> | string;

export type ThrottlerGenerateKeyFunction = (
  context: ExecutionContext,
  trackerString: string,
  throttlerName: string,
) => string;

export type ThrottlerSkipIfFunction = (
  context: ExecutionContext,
) => Promise<boolean> | boolean;

export interface ThrottlerOptions {
  name?: string;
  /** Time window in milliseconds (or dynamic resolver) */
  ttl: Resolvable<number>;
  /** Max allowed requests within `ttl` (or dynamic resolver) */
  limit: Resolvable<number>;
  /** Optional block duration in milliseconds once limit is exceeded */
  blockDuration?: Resolvable<number>;
  ignoreUserAgents?: RegExp[];
  skipIf?: ThrottlerSkipIfFunction;
  getTracker?: ThrottlerGetTrackerFunction;
  generateKey?: ThrottlerGenerateKeyFunction;
  setHeaders?: boolean;
}

export interface ThrottlerRule extends ThrottlerOptions {}

export interface ThrottlerStorageRecord {
  readonly totalHits: number;
  /** Milliseconds remaining until window expires */
  readonly timeToExpire: number;
  readonly isBlocked: boolean;
  /** Milliseconds remaining until block expires (0 if not blocked) */
  readonly timeToBlockExpire: number;
}

export interface ThrottlerStorageOptions {
  totalHits: Map<string, number>;
  expiresAt: number;
  isBlocked: boolean;
  blockExpiresAt: number;
}

export interface ThrottlerStorage extends Partial<OnModuleDestroy> {
  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration?: number,
    throttlerName?: string,
  ): Promise<ThrottlerStorageRecord> | ThrottlerStorageRecord;
  reset?(key: string): Promise<void> | void;
  clear?(): Promise<void> | void;
}

export const ThrottlerStorage: symbol = THROTTLER_STORAGE;

export interface ThrottlerLimitDetail extends ThrottlerStorageRecord {
  ttl: number;
  limit: number;
  key: string;
  tracker: string;
}

export interface ThrottlerRequest {
  context: ExecutionContext;
  limit: number;
  ttl: number;
  throttler: ThrottlerOptions;
  blockDuration: number;
  getTracker: ThrottlerGetTrackerFunction;
  generateKey: ThrottlerGenerateKeyFunction;
}

export interface ThrottlerModuleOptionsObject {
  throttlers: readonly ThrottlerOptions[];
  storage?: ThrottlerStorage;
  getTracker?: ThrottlerGetTrackerFunction;
  generateKey?: ThrottlerGenerateKeyFunction;
  skipIf?: ThrottlerSkipIfFunction;
  ignoreUserAgents?: RegExp[];
  ipv6SubnetPrefix?: number;
  errorMessage?:
    | string
    | ((
        context: ExecutionContext,
        throttlerLimitDetail: ThrottlerLimitDetail,
      ) => string);
  setHeaders?: boolean;
  global?: boolean;
}

export type ThrottlerModuleOptions =
  readonly ThrottlerOptions[] | ThrottlerModuleOptionsObject;

export function isThrottlerOptionsArray(
  options: ThrottlerModuleOptions,
): options is readonly ThrottlerOptions[] {
  return Array.isArray(options);
}

export interface ThrottlerOptionsFactory {
  createThrottlerOptions():
    Promise<ThrottlerModuleOptions> | ThrottlerModuleOptions;
}

export interface ThrottlerAsyncOptions {
  imports?: ModuleMetadata["imports"];
  useExisting?: Type<ThrottlerOptionsFactory>;
  useClass?: Type<ThrottlerOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => ThrottlerModuleOptions | Promise<ThrottlerModuleOptions>;
  inject?: FactoryDependency[];
  global?: boolean;
}

export interface ThrottlerModuleAsyncOptions extends ThrottlerAsyncOptions {}

export type ThrottleOverride = Partial<
  Pick<
    ThrottlerOptions,
    "ttl" | "limit" | "blockDuration" | "getTracker" | "generateKey"
  >
>;

export type ThrottleDecoratorConfig =
  | {
      ttl: Resolvable<number>;
      limit: Resolvable<number>;
      blockDuration?: Resolvable<number>;
      getTracker?: ThrottlerGetTrackerFunction;
      generateKey?: ThrottlerGenerateKeyFunction;
    }
  | Record<string, ThrottleOverride>;
