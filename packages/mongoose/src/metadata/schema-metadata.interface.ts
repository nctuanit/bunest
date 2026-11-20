import type { SchemaOptions } from "../interfaces/schema-types.interface";
import type { PropertyMetadata } from "./property-metadata.interface";

export interface SchemaMetadata {
  target: Function;
  options?: SchemaOptions;
  properties?: PropertyMetadata[];
}
