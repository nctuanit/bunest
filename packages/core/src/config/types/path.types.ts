/**
 * Evaluates to `true` if `T` is `any`, `false` otherwise.
 */
type IsAny<T> = unknown extends T
  ? [keyof T] extends [never]
    ? false
    : true
  : false;

/**
 * Recursive dot-path helper for nested configuration objects.
 */
export type PathImpl<T, Key extends keyof T> = Key extends string
  ? IsAny<T[Key]> extends true
    ? never
    : T[Key] extends Record<string, any>
      ? | `${Key}.${PathImpl<T[Key], Exclude<keyof T[Key], keyof any[]>> & string}`
        | `${Key}.${Exclude<keyof T[Key], keyof any[]> & string}`
      : never
  : never;

export type PathImpl2<T> = PathImpl<T, keyof T> | keyof T;

/**
 * Union of all valid top-level and dot-separated nested property paths of `T`.
 */
export type Path<T> = keyof T extends string
  ? PathImpl2<T> extends infer P
    ? P extends string | keyof T
      ? P
      : keyof T
    : keyof T
  : never;

/**
 * Resolves the property value type at dot-path `P` inside configuration type `T`.
 */
export type PathValue<
  T,
  P extends Path<T>,
> = P extends `${infer Key}.${infer Rest}`
  ? Key extends keyof T
    ? Rest extends Path<T[Key]>
      ? PathValue<T[Key], Rest>
      : never
    : never
  : P extends keyof T
    ? T[P]
    : never;

/**
 * Prevents TypeScript from inferring a generic type parameter from a position
 * (e.g. `defaultValue` in `ConfigService.get()`).
 */
export type NoInferType<T> = [T][T extends any ? 0 : never];

/**
 * Extracts the resolved return type of a `registerAs()` factory function
 * (unwrapping `Promise<T>` for async factories).
 *
 * @example
 * ```ts
 * constructor(@Inject(dbConfig.KEY) private db: ConfigType<typeof dbConfig>) {}
 * ```
 */
export type ConfigType<T extends (...args: any) => any> = T extends (
  ...args: any
) => infer ReturnVal
  ? ReturnVal extends Promise<infer AsyncReturnVal>
    ? AsyncReturnVal
    : ReturnVal
  : any;

/**
 * Custom `.env` file content parser returning key-value pairs.
 */
export type Parser = (content: string) => Record<string, any>;

/**
 * Options passed to `ConfigService.get()` / `ConfigService.getOrThrow()` to
 * infer the return type automatically from the `ConfigService<K>` type argument.
 */
export interface ConfigGetOptions {
  /**
   * When `true`, infers the return type from the dot-path against `ConfigService<K>`.
   */
  infer: true;
}

/**
 * Event emitted on `ConfigService.changes$` whenever `ConfigService.set()` updates a value.
 */
export interface ConfigChangeEvent<OldValue = any, NewValue = any> {
  path: string;
  oldValue: OldValue;
  newValue: NewValue;
}

/**
 * Handle returned by `ConfigService.changes$.subscribe(...)` to detach a listener.
 */
export interface ConfigSubscription {
  unsubscribe(): void;
}

/**
 * Observer object accepted by `ConfigService.changes$.subscribe(...)` (zero-RxJS compatible).
 */
export interface ConfigObserver<T> {
  next?: (value: T) => void;
  error?: (err: unknown) => void;
  complete?: () => void;
}

/**
 * Lightweight zero-RxJS subscribable matching RxJS `.subscribe()` ergonomics.
 */
export interface ConfigSubscribable<T> {
  subscribe(
    observerOrNext?: ConfigObserver<T> | ((value: T) => void),
  ): ConfigSubscription;
}
