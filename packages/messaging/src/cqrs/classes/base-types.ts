export const RESULT_TYPE_SYMBOL = Symbol("RESULT_TYPE_SYMBOL");

export interface ICommand {}

export interface IQuery {}

export interface IEvent {}

export interface IQueryResult {}

export interface Constructor<T = any> {
  new (...args: any[]): T;
}

export type AbstractConstructor<T = {}> = abstract new (...args: any[]) => T;
