import type { Type } from "@bunest/common";
import { ObjectId } from "../driver/object-id";
import { MongooseSchema, MongooseSchemaType } from "../driver/schema";
import type { SchemaDefinition } from "../interfaces/schema-types.interface";
import { TypeMetadataStorage } from "../storages/type-metadata.storage";
import { isUndefined } from "../utils/shared.utils";

const BUILT_IN_TYPES: ReadonlyArray<Function> = [
  Boolean,
  Number,
  String,
  Map,
  Date,
  Buffer,
  BigInt,
  ObjectId,
];

export class DefinitionsFactory {
  static createForClass(target: Type<unknown>): SchemaDefinition {
    if (!target) {
      throw new Error(
        `Target class "${target}" passed in to the "DefinitionsFactory#createForClass()" method is "undefined".`,
      );
    }

    let schemaDefinition: SchemaDefinition = {};
    let parent: any = target;

    while (!isUndefined(parent?.prototype)) {
      if (parent === Function.prototype) {
        break;
      }
      const schemaMetadata =
        TypeMetadataStorage.getSchemaMetadataByTarget(parent);
      if (!schemaMetadata) {
        parent = Object.getPrototypeOf(parent);
        continue;
      }
      schemaMetadata.properties?.forEach((item) => {
        const options = this.inspectTypeDefinition(item.options);
        this.inspectRef(item.options);
        schemaDefinition = {
          [item.propertyKey]: options,
          ...schemaDefinition,
        };
      });
      parent = Object.getPrototypeOf(parent);
    }

    return schemaDefinition;
  }

  private static inspectTypeDefinition(optionsOrType: any): any {
    if (typeof optionsOrType === "function") {
      if (this.isPrimitive(optionsOrType)) {
        return optionsOrType;
      } else if (this.isMongooseSchemaType(optionsOrType)) {
        return optionsOrType;
      }
      const isClass = /^class\s/.test(
        Function.prototype.toString.call(optionsOrType),
      );
      const resolvedTarget = isClass ? optionsOrType : optionsOrType();
      if (
        this.isPrimitive(resolvedTarget) ||
        this.isMongooseSchemaType(resolvedTarget)
      ) {
        return resolvedTarget;
      }
      const schemaDefinition = this.createForClass(resolvedTarget);
      const schemaMetadata =
        TypeMetadataStorage.getSchemaMetadataByTarget(resolvedTarget);
      if (schemaMetadata?.options) {
        return new MongooseSchema(schemaDefinition, schemaMetadata.options);
      }
      return schemaDefinition;
    } else if (
      optionsOrType &&
      typeof optionsOrType === "object" &&
      (typeof optionsOrType.type === "function" ||
        (Array.isArray(optionsOrType.type) &&
          typeof optionsOrType.type[0] === "function"))
    ) {
      optionsOrType.type = this.inspectTypeDefinition(optionsOrType.type);
      return optionsOrType;
    } else if (Array.isArray(optionsOrType)) {
      return optionsOrType.length > 0
        ? [this.inspectTypeDefinition(optionsOrType[0])]
        : optionsOrType;
    }
    return optionsOrType;
  }

  private static inspectRef(optionsOrType: any): void {
    if (!optionsOrType || typeof optionsOrType !== "object") {
      return;
    }
    if (typeof optionsOrType.ref === "function") {
      try {
        const result = optionsOrType.ref();
        if (typeof result?.name === "string") {
          optionsOrType.ref = result.name;
        }
      } catch (err) {
        if (err instanceof TypeError) {
          const refClassName = optionsOrType.ref?.name;
          throw new Error(
            `Unsupported syntax: Class constructor "${refClassName}" cannot be invoked without 'new'. Make sure to wrap your class reference in an arrow function (for example, "ref: () => ${refClassName}").`,
          );
        }
        throw err;
      }
    } else if (Array.isArray(optionsOrType.type)) {
      if (optionsOrType.type.length > 0) {
        this.inspectRef(optionsOrType.type[0]);
      }
    }
  }

  private static isPrimitive(type: Function): boolean {
    return BUILT_IN_TYPES.includes(type);
  }

  private static isMongooseSchemaType(type: Function): boolean {
    if (!type || !type.prototype) {
      return false;
    }
    if (type === MongooseSchemaType) {
      return true;
    }
    const prototype = Object.getPrototypeOf(type.prototype);
    return Boolean(
      prototype &&
        (prototype.constructor === MongooseSchemaType ||
          prototype.constructor?.name === "SchemaType"),
    );
  }
}
