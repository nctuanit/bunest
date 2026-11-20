import type { VirtualTypeOptions } from "../interfaces/schema-types.interface";

export interface VirtualMetadataInterface {
  target: Function;
  name: string;
  options?: VirtualTypeOptions;
  getter?: (...args: any[]) => any;
  setter?: (...args: any[]) => any;
}
