# @bunest/mongoose

NestJS v12-compatible Mongoose ODM module for **Bunest** with zero external npm runtime dependencies. Includes schema decorators, factories, ObjectId validation pipes, and a built-in Bun-native structural MongoDB/Mongoose driver.

## Features

- **Full `@nestjs/mongoose` v12 Parity**: `MongooseModule` (`forRoot`, `forRootAsync`, `forFeature`, `forFeatureAsync`), `@Schema()`, `@Prop()`, `@Virtual()`, `raw()`, `SchemaFactory`, `DefinitionsFactory`, and `VirtualsFactory`.
- **DI Decorators & Multi-Connection Support**: `@InjectModel()`, `@InjectConnection()`, `getModelToken()`, and `getConnectionToken()`.
- **Built-in Structural Runtime**: Zero-dependency Bun-native `MongooseConnection`, `MongooseSchema`, `MongooseModel`, `MongooseDocument`, `MongooseQuery`, and `ObjectId` engine for out-of-the-box local execution and testing.
- **External Mongoose Interop**: Seamlessly accepts real user-supplied `mongoose` connections via `connectionFactory`.
- **Validation Pipes & Promise-Only Retries**: `IsObjectIdPipe`, `ParseObjectIdPipe`, `CannotDetermineTypeError`, and zero-RxJS `handleRetry`.

## Installation

```bash
bun add @bunest/mongoose
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  InjectModel,
  MongooseModel,
  MongooseModule,
  Prop,
  Schema,
  SchemaFactory,
} from "@bunest/mongoose";

@Schema({ timestamps: true })
export class Cat {
  @Prop({ required: true })
  name!: string;

  @Prop()
  age?: number;
}

export const CatSchema = SchemaFactory.createForClass(Cat);

@Injectable()
export class CatsService {
  constructor(@InjectModel(Cat.name) private readonly catModel: MongooseModel<Cat>) {}

  create(name: string, age: number) {
    return this.catModel.create({ name, age });
  }

  findAll() {
    return this.catModel.find().exec();
  }
}

@Module({
  imports: [
    MongooseModule.forRoot("mongodb://localhost/cats"),
    MongooseModule.forFeature([{ name: Cat.name, schema: CatSchema }]),
  ],
  providers: [CatsService],
})
export class AppModule {}
```

## Key Exports

- **Module & Providers**: `MongooseModule`, `MongooseCoreModule`, `createMongooseProviders`, `createMongooseAsyncProviders`, `handleRetry`
- **Decorators**: `Schema`, `Prop`, `Virtual`, `InjectModel`, `InjectConnection`, `raw`
- **Factories & Storage**: `SchemaFactory`, `DefinitionsFactory`, `VirtualsFactory`, `TypeMetadataStorage`, `TypeMetadataStorageHost`
- **Runtime Engine**: `createConnection`, `MongooseConnection`, `MongooseCollection`, `MongooseModel`, `MongooseDocument`, `MongooseQuery`, `MongooseSchema`, `MongooseSchemaType`, `MongooseVirtualType`, `ObjectId`, `SchemaTypes`
- **Pipes, Tokens & Errors**: `IsObjectIdPipe`, `ParseObjectIdPipe`, `getModelToken`, `getConnectionToken`, `DEFAULT_DB_CONNECTION`, `MONGOOSE_CONNECTION_NAME`, `MONGOOSE_MODULE_OPTIONS`, `MongooseError`, `CannotDetermineTypeError`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
