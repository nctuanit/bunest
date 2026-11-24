export type ClassConstructor<T = unknown> = {
  new (...args: never[]): T;
};

export interface TargetMap {
  target: Function;
  properties: Record<string, Function>;
}

export interface ClassTransformOptions {
  /**
   * Exclusion strategy. By default exposeAll is used, exposing all properties unless explicitly excluded.
   */
  strategy?: "excludeAll" | "exposeAll";
  /**
   * Indicates if extraneous properties should be excluded when transforming.
   */
  excludeExtraneousValues?: boolean;
  /**
   * Only properties matching given groups will be transformed.
   */
  groups?: string[];
  /**
   * Only properties with `since <= version < until` will be transformed.
   */
  version?: number;
  /**
   * Excludes properties starting with any of the given prefixes.
   */
  excludePrefixes?: string[];
  /**
   * If true, ignores `@Expose`, `@Exclude`, and `@Transform` decorators.
   */
  ignoreDecorators?: boolean;
  /**
   * Schema-less type mappings alternative to `@Type()`.
   */
  targetMaps?: TargetMap[];
  /**
   * If true, tracks active ancestors to prevent infinite recursion on circular graphs.
   */
  enableCircularCheck?: boolean;
  /**
   * If true, performs safe primitive/class conversion based on TypeScript `design:type`
   * (per ADR-015: `"false"` -> `false`, `""` stays unchanged instead of `0`).
   */
  enableImplicitConversion?: boolean;
  /**
   * If true, keeps default class property initializers for omitted fields.
   */
  exposeDefaultValues?: boolean;
  /**
   * When true (default), fields with `undefined` value are included in output.
   * When false, `undefined` fields are omitted.
   * @default true
   */
  exposeUnsetFields?: boolean;
}

export const DEFAULT_TRANSFORM_OPTIONS: Readonly<ClassTransformOptions> =
  Object.freeze({
    enableCircularCheck: false,
    enableImplicitConversion: false,
    excludeExtraneousValues: false,
    excludePrefixes: undefined,
    exposeDefaultValues: false,
    exposeUnsetFields: true,
    groups: undefined,
    ignoreDecorators: false,
    strategy: undefined,
    targetMaps: undefined,
    version: undefined,
  });
