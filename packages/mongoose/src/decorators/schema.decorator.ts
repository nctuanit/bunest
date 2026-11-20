import type { SchemaOptions } from "../interfaces/schema-types.interface";
import { TypeMetadataStorage } from "../storages/type-metadata.storage";

export function Schema(options?: SchemaOptions): ClassDecorator {
  return (target: Function) => {
    TypeMetadataStorage.addSchemaMetadata({
      target,
      options,
    });
  };
}
