import type {
  TypeHelpOptions,
  TypeOptions,
} from "../interfaces/decorator-options.interface";
import { defaultMetadataStorage } from "../storage/metadata-storage";
import { readDesignType } from "../engine/builtins.util";

export function Type(
  typeFunction?: (type?: TypeHelpOptions) => Function,
  options: TypeOptions = {},
): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    const prop = String(propertyName);
    const reflectedType = readDesignType(target, prop);
    defaultMetadataStorage.addTypeMetadata({
      target: target.constructor,
      propertyName: prop,
      reflectedType,
      typeFunction,
      options,
    });
  };
}
