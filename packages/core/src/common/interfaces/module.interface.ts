import type { Provider } from "./provider.interface";
import type {
  Abstract,
  ForwardReference,
  InjectionToken,
  Type,
} from "./type.interface";

export type ModuleImport =
  | Type<any>
  | DynamicModule
  | Promise<DynamicModule>
  | ForwardReference<Type<any> | DynamicModule>;

export type ModuleExport =
  | DynamicModule
  | Promise<DynamicModule>
  | InjectionToken
  | Provider
  | ForwardReference<any>
  | Abstract<any>
  | Function;

export interface AutoDiscoverOptions {
  readonly controllers?: boolean;
  readonly providers?: boolean;
  readonly include?: ReadonlyArray<Type<unknown>>;
  readonly exclude?: ReadonlyArray<Type<unknown>>;
}

export interface ModuleMetadata {
  imports?: ModuleImport[];
  controllers?: Type<any>[];
  providers?: Provider[];
  exports?: ModuleExport[];
  autoDiscover?: boolean | AutoDiscoverOptions;
}

export interface DynamicModule extends ModuleMetadata {
  module: Type<any>;
  global?: boolean;
}

export function isDynamicModule(value: unknown): value is DynamicModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "module" in value &&
    typeof (value as DynamicModule).module === "function"
  );
}
