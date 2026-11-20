import { RESULT_TYPE_SYMBOL, type IQuery } from "./base-types";

/**
 * Utility type to extract the result type `R` of a typed `Query<R>`.
 */
export type QueryResult<C extends Query<unknown>> =
  C extends Query<infer R> ? R : never;

/**
 * Base class for strongly-typed CQRS queries carrying a phantom result type `T`.
 * Enables automatic return-type inference on `queryBus.execute(new MyQuery())`
 * and `implements IQueryHandler<MyQuery>`.
 */
export class Query<T> implements IQuery {
  declare readonly [RESULT_TYPE_SYMBOL]: T;
}
