import type { Type } from "@bunest/common";
import type { MongooseSchemaLike } from "../interfaces/schema-types.interface";
import { TypeMetadataStorage } from "../storages/type-metadata.storage";
import { isUndefined } from "../utils/shared.utils";

export class VirtualsFactory {
  static inspect<TClass = any>(
    target: Type<TClass>,
    schema: MongooseSchemaLike<TClass>,
  ): void {
    let parent: any = target;
    while (!isUndefined(parent?.prototype)) {
      if (parent === Function.prototype) {
        break;
      }
      const virtuals = TypeMetadataStorage.getVirtualsMetadataByTarget(parent);
      virtuals.forEach(({ options, name, getter, setter }) => {
        const virtual = schema.virtual(name, options);
        if (getter) {
          virtual.get(getter);
        }
        if (setter) {
          virtual.set(setter);
        }
      });
      parent = Object.getPrototypeOf(parent);
    }
  }
}
