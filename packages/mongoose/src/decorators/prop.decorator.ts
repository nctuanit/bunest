import { CannotDetermineTypeError } from "../errors/cannot-determine-type.error";
import type { PropOptions } from "../interfaces/schema-types.interface";
import { RAW_OBJECT_DEFINITION } from "../mongoose.constants";
import { TypeMetadataStorage } from "../storages/type-metadata.storage";

const TYPE_METADATA_KEY = "design:type";

export function Prop(options?: PropOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const resolvedOptions: Record<string, any> = (options ?? {}) as Record<
      string,
      any
    >;
    const isRawDefinition = Boolean(resolvedOptions[RAW_OBJECT_DEFINITION]);

    if (
      !resolvedOptions.type &&
      !Array.isArray(resolvedOptions) &&
      !isRawDefinition
    ) {
      const type = Reflect.getMetadata(TYPE_METADATA_KEY, target, propertyKey);
      if (type === Array) {
        resolvedOptions.type = [];
      } else if (type && type !== Object) {
        resolvedOptions.type = type;
      } else {
        throw new CannotDetermineTypeError(
          target.constructor?.name ?? "Unknown",
          String(propertyKey),
        );
      }
    }

    TypeMetadataStorage.addPropertyMetadata({
      target: target.constructor,
      propertyKey: String(propertyKey),
      options: resolvedOptions as PropOptions,
    });
  };
}
