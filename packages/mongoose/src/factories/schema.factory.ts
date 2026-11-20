import type { Type } from "@bunest/common";
import { MongooseSchema } from "../driver/schema";
import { TypeMetadataStorage } from "../storages/type-metadata.storage";
import { DefinitionsFactory } from "./definitions.factory";
import { VirtualsFactory } from "./virtuals.factory";

export class SchemaFactory {
  static createForClass<TClass = any>(
    target: Type<TClass>,
  ): MongooseSchema<TClass> {
    const schemaDefinition = DefinitionsFactory.createForClass(target);
    const schemaMetadata =
      TypeMetadataStorage.getSchemaMetadataByTarget(target);
    const schemaOpts = schemaMetadata?.options;
    const schema = new MongooseSchema<TClass>(schemaDefinition, schemaOpts);
    VirtualsFactory.inspect(target, schema);
    return schema;
  }
}
