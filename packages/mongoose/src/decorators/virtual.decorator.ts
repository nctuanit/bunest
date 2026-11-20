import type { VirtualOptions } from "../interfaces/schema-types.interface";
import { TypeMetadataStorage } from "../storages/type-metadata.storage";

export function Virtual(options?: VirtualOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    TypeMetadataStorage.addVirtualMetadata({
      target: target.constructor,
      options: options?.options,
      name:
        String(propertyKey) +
        (options?.subPath ? `.${options.subPath}` : ""),
      setter: options?.set,
      getter: options?.get,
    });
  };
}
