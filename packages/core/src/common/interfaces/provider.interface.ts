import type { Scope } from "../enums/scope.enum";
import type { ForwardReference, InjectionToken, Type } from "./type.interface";

export interface InjectableOptions {
  scope?: Scope;
  durable?: boolean;
}

export interface InjectableMetadata {
  scope: Scope;
  durable?: boolean;
}

export interface OptionalFactoryDependency {
  token: InjectionToken | ForwardReference;
  optional: boolean;
}

export type FactoryDependency =
  InjectionToken | ForwardReference | OptionalFactoryDependency;

export interface ClassProvider<T = any> {
  provide: InjectionToken<T>;
  useClass: Type<T>;
  scope?: Scope;
  durable?: boolean;
  inject?: FactoryDependency[];
}

export interface ValueProvider<T = any> {
  provide: InjectionToken<T>;
  useValue: T;
  inject?: never;
}

export interface FactoryProvider<T = any> {
  provide: InjectionToken<T>;
  useFactory: (...args: any[]) => T | Promise<T>;
  inject?: FactoryDependency[];
  scope?: Scope;
  durable?: boolean;
}

export interface ExistingProvider<T = any> {
  provide: InjectionToken<T>;
  useExisting: InjectionToken<T>;
}

export type Provider<T = any> =
  | Type<T>
  | ClassProvider<T>
  | ValueProvider<T>
  | FactoryProvider<T>
  | ExistingProvider<T>;

export interface InjectTokenMetadata {
  readonly index: number;
  readonly token: InjectionToken | ForwardReference;
}

export interface PropertyInjectMetadata {
  readonly propertyKey: string | symbol;
  readonly token: InjectionToken | ForwardReference;
}
