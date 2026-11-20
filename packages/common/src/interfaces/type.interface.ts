export interface Type<T = any> extends Function {
  new (...args: any[]): T;
}

export type Abstract<T = any> = abstract new (...args: any[]) => T;

export type InjectionToken<T = any> =
  | Type<T>
  | Abstract<T>
  | string
  | symbol;

export interface ForwardReference<T = any> {
  readonly forwardRef: () => T;
}

/**
 * Allows referencing a class or module that has not yet been defined,
 * breaking circular reference issues in decorator metadata.
 */
export function forwardRef<T = any>(fn: () => T): ForwardReference<T> {
  return { forwardRef: fn };
}

export function isForwardReference<T = any>(
  value: unknown,
): value is ForwardReference<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "forwardRef" in value &&
    typeof (value as ForwardReference).forwardRef === "function"
  );
}
