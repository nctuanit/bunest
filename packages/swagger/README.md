# @bunest/swagger

OpenAPI 3.1 metadata decorators, `DocumentBuilder`, schema introspection, and Swagger UI explorer for **Bunest** with zero external runtime dependencies.

## Features

- **Full `@nestjs/swagger` Decorator Surface**: `@ApiTags()`, `@ApiOperation()`, `@ApiProperty()`, `@ApiPropertyOptional()`, `@ApiBody()`, `@ApiParam()`, `@ApiQuery()`, `@ApiHeader()`, `@ApiResponse()`, status-specific `@ApiOkResponse()` / `@ApiCreatedResponse()` / `@ApiBadRequestResponse()`, auth decorators (`@ApiBearerAuth()`, `@ApiApiKey()`, `@ApiBasicAuth()`, `@ApiOAuth2()`, `@ApiCookieAuth()`), `@ApiDefaultGetter()`, and `@ApiWebhook()`.
- **Fluent Document Builder & API Versioning**: Construct OpenAPI 3.1 specifications with `DocumentBuilder`, `SwaggerModule.createDocument()`, `SwaggerModule.discoverApiVersions()`, `SwaggerModule.createVersionedDocuments()`, and single- or multi-version `SwaggerModule.setup()`.
- **DTO, Entity & Standard Schema Introspection**: `SchemaExplorer` introspects TypeScript metadata, `@bunest/validation` rules, `@Entity()` / `@Column()` ORM decorators (hiding `select: false` columns automatically), and Standard JSON Schema (`defaultStandardSchemaConverter`) into OpenAPI schemas.
- **Build-Time Plugin Metadata**: Load precompiled CLI metadata via `SwaggerModule.loadPluginMetadata()` to populate DTO properties and controller summaries/responses without manual decorators.
- **Mapped DTO Helpers**: Re-exports `PartialType`, `PickType`, `OmitType`, `IntersectionType`, `CompositionType`, and `DeepPartialType` preserving `@ApiProperty` metadata.
- **JSON, YAML & Interactive UI Presets**: Built-in `serializeToYaml()`, `renderSwaggerHtml()`, and three UI presets (`"builtin"`, `"swagger-ui"`, and `"scalar"`) with automatic version switcher support.

## Installation

```bash
bun add @bunest/swagger
```

## Quick Start

```ts
import { BunestFactory, Controller, Get, Module } from "@bunest/core";
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  DocumentBuilder,
  SwaggerModule,
} from "@bunest/swagger";

export class UserDto {
  @ApiProperty({ example: "usr_1" })
  id!: string;

  @ApiProperty({ example: "Ada Lovelace" })
  name!: string;
}

@ApiTags("users")
@Controller("users")
export class UsersController {
  @Get()
  @ApiOperation({ summary: "List all users" })
  @ApiOkResponse({ type: [UserDto] })
  findAll(): UserDto[] {
    return [{ id: "usr_1", name: "Ada Lovelace" }];
  }
}

@Module({ controllers: [UsersController] })
export class AppModule {}

const app = await BunestFactory.create(AppModule);
const config = new DocumentBuilder()
  .setTitle("Users API")
  .setVersion("1.0")
  .addBearerAuth()
  .build();
const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup("docs", app, document, {
  ui: "builtin", // "builtin" | "swagger-ui" | "scalar"
});
await app.listen(3000);
```

## API Versioning & UI Presets

```ts
const versions = SwaggerModule.discoverApiVersions(app);
const docs = SwaggerModule.createVersionedDocuments(app, config, {
  versions,
  includeVersionNeutral: true,
});

SwaggerModule.setup("docs", app, docs, {
  defaultVersion: "2",
  ui: "scalar", // "builtin" | "swagger-ui" | "scalar"
});
```

## Entity Introspection & Build-Time Metadata

- **`@Entity()` / `@Column()` Introspection**: Entities decorated with `@Entity()`, `@Column()`, `@PrimaryGeneratedColumn()`, `@CreateDateColumn()`, and `@UpdateDateColumn()` are automatically reflected into OpenAPI schemas (column types, constraints, nullability, defaults, descriptions, and hiding `select: false` columns).
- **CLI Metadata Plugin**: Call `await SwaggerModule.loadPluginMetadata(metadata)` before `SwaggerModule.createDocument()` to hydrate build-time DTO and controller metadata.

## Key Exports

- **Core**: `SwaggerModule` (`createDocument`, `createVersionedDocuments`, `discoverApiVersions`, `loadPluginMetadata`, `setup`), `DocumentBuilder`, `SchemaExplorer`, `generateSchema`, `defaultStandardSchemaConverter`, `convertPathToOpenApi`, `renderSwaggerHtml`, `serializeToYaml`
- **Decorators**: `ApiTags`, `ApiOperation`, `ApiProperty`, `ApiPropertyOptional`, `ApiResponseProperty`, `ApiHideProperty`, `ApiSchema`, `ApiBody`, `ApiParam`, `ApiQuery`, `ApiHeader`, `ApiHeaders`, `ApiResponse`, `ApiOkResponse`, `ApiCreatedResponse`, `ApiBadRequestResponse`, `ApiUnauthorizedResponse`, `ApiNotFoundResponse`, `ApiBearerAuth`, `ApiApiKey`, `ApiBasicAuth`, `ApiOAuth2`, `ApiCookieAuth`, `ApiSecurity`, `ApiExtraModels`, `ApiExcludeController`, `ApiExcludeEndpoint`, `ApiDefaultGetter`, `ApiWebhook`, `getSchemaPath`, `refs`
- **Mapped Types**: `PartialType`, `PickType`, `OmitType`, `IntersectionType`, `CompositionType`, `DeepPartialType`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
