import type { ExcludeOptions } from "../interfaces/decorator-options.interface";
import { defaultMetadataStorage } from "../storage/metadata-storage";

export function Exclude(
  options: ExcludeOptions = {},
): PropertyDecorator & ClassDecorator {
  return (object: object | Function, propertyName?: string | symbol): void => {
    const target = typeof object === "function" ? object : object.constructor;
    defaultMetadataStorage.addExcludeMetadata({
      target,
      propertyName:
        propertyName !== undefined ? String(propertyName) : undefined,
      options,
    });
  };
}
