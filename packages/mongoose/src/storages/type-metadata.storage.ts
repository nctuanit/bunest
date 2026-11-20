import type { Type } from "@bunest/common";
import type { PropertyMetadata } from "../metadata/property-metadata.interface";
import type { SchemaMetadata } from "../metadata/schema-metadata.interface";
import type { VirtualMetadataInterface } from "../metadata/virtual-metadata.interface";
import { isTargetEqual } from "../utils/is-target-equal.util";

export class TypeMetadataStorageHost {
  private schemas: SchemaMetadata[] = [];
  private properties: PropertyMetadata[] = [];
  private virtuals: VirtualMetadataInterface[] = [];

  addPropertyMetadata(metadata: PropertyMetadata): void {
    this.properties.unshift(metadata);
  }

  addSchemaMetadata(metadata: SchemaMetadata): void {
    this.compileClassMetadata(metadata);
    this.schemas.push(metadata);
  }

  addVirtualMetadata(metadata: VirtualMetadataInterface): void {
    this.virtuals.push(metadata);
  }

  getSchemaMetadataByTarget(
    target: Type<unknown> | Function,
  ): SchemaMetadata | undefined {
    return this.schemas.find((item) => item.target === target);
  }

  getVirtualsMetadataByTarget<TClass>(
    targetFilter: Type<TClass> | Function,
  ): VirtualMetadataInterface[] {
    return this.virtuals.filter(({ target }) => target === targetFilter);
  }

  private compileClassMetadata(metadata: SchemaMetadata): void {
    const belongsToClass = isTargetEqual.bind(undefined, metadata);
    if (!metadata.properties) {
      metadata.properties = this.getClassFieldsByPredicate(belongsToClass);
    }
  }

  private getClassFieldsByPredicate(
    belongsToClass: (item: PropertyMetadata) => boolean,
  ): PropertyMetadata[] {
    return this.properties.filter(belongsToClass);
  }
}

const globalRef = globalThis as typeof globalThis & {
  MongoTypeMetadataStorage?: TypeMetadataStorageHost;
};

export const TypeMetadataStorage: TypeMetadataStorageHost =
  globalRef.MongoTypeMetadataStorage ??
  (globalRef.MongoTypeMetadataStorage = new TypeMetadataStorageHost());
