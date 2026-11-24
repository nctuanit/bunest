import type { FindOperatorLike, FindOperatorType } from "./types";

/**
 * TypeORM-compatible FindOperator wrapper representing SQL predicates
 * (`Equal`, `Not`, `LessThan`, `MoreThan`, `Like`, `ILike`, `Between`, `In`, `IsNull`, `Raw`, `And`, `Or`).
 */
export class FindOperator<T = unknown> implements FindOperatorLike<T> {
  readonly __ormFindOperator = true as const;
  readonly type: FindOperatorType;
  readonly value: T;
  readonly extra?: unknown;
  readonly negated?: boolean;

  constructor(
    type: FindOperatorType,
    value: T,
    extra?: unknown,
    negated?: boolean,
  ) {
    this.type = type;
    this.value = value;
    this.extra = extra;
    this.negated = negated;
  }
}

export function isFindOperator(value: unknown): value is FindOperatorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __ormFindOperator?: unknown }).__ormFindOperator === true
  );
}

export function Equal<T>(value: T): FindOperator<T> {
  return new FindOperator("equal", value);
}

export function Not<T>(
  value: T | FindOperatorLike<T>,
): FindOperator<T | FindOperatorLike<T>> {
  return new FindOperator("not", value, undefined, true);
}

export function LessThan<T>(value: T): FindOperator<T> {
  return new FindOperator("lessThan", value);
}

export function LessThanOrEqual<T>(value: T): FindOperator<T> {
  return new FindOperator("lessThanOrEqual", value);
}

export function MoreThan<T>(value: T): FindOperator<T> {
  return new FindOperator("moreThan", value);
}

export function MoreThanOrEqual<T>(value: T): FindOperator<T> {
  return new FindOperator("moreThanOrEqual", value);
}

export function Like(value: string): FindOperator<string> {
  return new FindOperator("like", value);
}

export function ILike(value: string): FindOperator<string> {
  return new FindOperator("ilike", value);
}

export function Between<T>(from: T, to: T): FindOperator<readonly [T, T]> {
  return new FindOperator("between", [from, to] as const);
}

export function In<T>(values: readonly T[]): FindOperator<readonly T[]> {
  return new FindOperator("in", values);
}

export function IsNull(): FindOperator<null> {
  return new FindOperator("isNull", null);
}

export function Raw(
  sqlOrBuilder: string | ((columnAlias: string) => string),
  parameters?: Record<string, unknown>,
): FindOperator<string | ((columnAlias: string) => string)> {
  return new FindOperator("raw", sqlOrBuilder, parameters);
}

export function And(
  ...operators: Array<FindOperatorLike<unknown> | unknown>
): FindOperator<Array<FindOperatorLike<unknown> | unknown>> {
  return new FindOperator("and", operators);
}

export function Or(
  ...operators: Array<FindOperatorLike<unknown> | unknown>
): FindOperator<Array<FindOperatorLike<unknown> | unknown>> {
  return new FindOperator("or", operators);
}
