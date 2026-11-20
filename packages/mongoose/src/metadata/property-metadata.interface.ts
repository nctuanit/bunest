import type { PropOptions } from "../interfaces/schema-types.interface";

export interface PropertyMetadata {
  target: Function;
  propertyKey: string;
  options: PropOptions;
}
