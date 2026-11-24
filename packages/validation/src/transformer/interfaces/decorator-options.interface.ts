import type { TransformationType } from "../enums/transformation-type.enum";
import type {
  ClassConstructor,
  ClassTransformOptions,
} from "./class-transform-options.interface";

export interface ExposeOptions {
  name?: string;
  since?: number;
  until?: number;
  groups?: string[];
  toClassOnly?: boolean;
  toPlainOnly?: boolean;
}

export interface ExcludeOptions {
  toClassOnly?: boolean;
  toPlainOnly?: boolean;
}

export interface TypeHelpOptions {
  newObject: Record<string, unknown>;
  object: Record<string, unknown>;
  property: string | undefined;
}

export interface JsonSubType {
  value: ClassConstructor<unknown>;
  name: string;
}

export interface Discriminator {
  property: string;
  subTypes: JsonSubType[];
}

export interface TypeOptions {
  discriminator?: Discriminator;
  keepDiscriminatorProperty?: boolean;
}

export interface TransformFnParams<
  TValue = unknown,
  TObj = Record<string, unknown>,
> {
  value: TValue;
  key: string;
  obj: TObj;
  type: TransformationType;
  options: ClassTransformOptions;
}

export type TransformFn = (params: TransformFnParams) => unknown;

export interface TransformOptions {
  since?: number;
  until?: number;
  groups?: string[];
  toClassOnly?: boolean;
  toPlainOnly?: boolean;
}
