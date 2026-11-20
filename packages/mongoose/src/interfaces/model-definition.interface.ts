import type { MongooseSchemaLike } from "./schema-types.interface";

export type DiscriminatorOptions = {
  name: string;
  schema: MongooseSchemaLike<any>;
  value?: string;
};

export type ModelDefinition = {
  name: string;
  schema: any;
  collection?: string;
  discriminators?: DiscriminatorOptions[];
};
