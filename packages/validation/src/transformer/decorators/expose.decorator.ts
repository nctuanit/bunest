import type { ExposeOptions } from "../interfaces/decorator-options.interface";
import { defaultMetadataStorage } from "../storage/metadata-storage";

export function Expose(
  options: ExposeOptions = {},
): PropertyDecorator & ClassDecorator {
  return (object: object | Function, propertyName?: string | symbol): void => {
    const target = typeof object === "function" ? object : object.constructor;
    defaultMetadataStorage.addExposeMetadata({
      target,
      propertyName:
        propertyName !== undefined ? String(propertyName) : undefined,
      options,
    });
  };
}
