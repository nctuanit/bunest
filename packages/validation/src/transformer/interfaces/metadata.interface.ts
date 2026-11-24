import type {
  ExcludeOptions,
  ExposeOptions,
  TransformFn,
  TransformOptions,
  TypeHelpOptions,
  TypeOptions,
} from "./decorator-options.interface";

export interface ExposeMetadata {
  target: Function;
  propertyName: string | undefined;
  options: ExposeOptions;
}

export interface ExcludeMetadata {
  target: Function;
  propertyName: string | undefined;
  options: ExcludeOptions;
}

export interface TypeMetadata {
  target: Function;
  propertyName: string;
  reflectedType: Function | undefined;
  typeFunction?: (options?: TypeHelpOptions) => Function;
  options: TypeOptions;
}

export interface TransformMetadata {
  target: Function;
  propertyName: string;
  transformFn: TransformFn;
  options: TransformOptions;
}

export interface CloneMetadataOptions {
  readonly propertyFilter?: (propertyName: string) => boolean;
  readonly stackTransforms?: boolean;
}
