import type {
  TransformFn,
  TransformOptions,
} from "../interfaces/decorator-options.interface";
import { defaultMetadataStorage } from "../storage/metadata-storage";

export function Transform(
  transformFn: TransformFn,
  options: TransformOptions = {},
): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    defaultMetadataStorage.addTransformMetadata({
      target: target.constructor,
      propertyName: String(propertyName),
      transformFn,
      options,
    });
  };
}
