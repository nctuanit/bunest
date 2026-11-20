# @bunest/swagger

OpenAPI 3.1 metadata decorators, `DocumentBuilder`, schema introspection, and Swagger UI explorer for **Bunest** with zero external runtime dependencies.

## Features

- **Full `@nestjs/swagger` Decorator Surface**: `@ApiTags()`, `@ApiOperation()`, `@ApiProperty()`, `@ApiPropertyOptional()`, `@ApiBody()`, `@ApiParam()`, `@ApiQuery()`, `@ApiHeader()`, `@ApiResponse()`, status-specific `@ApiOkResponse()` / `@ApiCreatedResponse()` / `@ApiBadRequestResponse()`, auth decorators (`@ApiBearerAuth()`, `@ApiApiKey()`, `@ApiBasicAuth()`, `@ApiOAuth2()`, `@ApiCookieAuth()`), and `@ApiWebhook()`.
- **Fluent Document Builder**: Construct OpenAPI 3.1 specifications with `DocumentBuilder`, `SwaggerModule.createDocument()`, and `SwaggerModule.setup()`.
- **DTO & Standard Schema Introspection**: `SchemaExplorer` introspects TypeScript metadata, `class-validator` rules, and Standard JSON Schema (`defaultStandardSchemaConverter`) into OpenAPI schemas.
- **Mapped DTO Helpers**: Re-exports `PartialType`, `PickType`, `OmitType`, `IntersectionType`, `CompositionType`, and `DeepPartialType` preserving `@ApiProperty` metadata.
- **JSON, YAML & Swagger UI**: Built-in `serializeToYaml()`, `renderSwaggerHtml()`, and safe HTML JSON serialization.

## Installation

```bash
bun add @bunest/swagger
```

## Quick Start

```ts
import { Controller, Get, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
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
SwaggerModule.setup("docs", app, document);
await app.listen(3000);
```

## Key Exports

- **Core**: `SwaggerModule`, `DocumentBuilder`, `SchemaExplorer`, `generateSchema`, `defaultStandardSchemaConverter`, `convertPathToOpenApi`, `renderSwaggerHtml`, `serializeToYaml`
- **Decorators**: `ApiTags`, `ApiOperation`, `ApiProperty`, `ApiPropertyOptional`, `ApiResponseProperty`, `ApiHideProperty`, `ApiSchema`, `ApiBody`, `ApiParam`, `ApiQuery`, `ApiHeader`, `ApiHeaders`, `ApiResponse`, `ApiOkResponse`, `ApiCreatedResponse`, `ApiBadRequestResponse`, `ApiUnauthorizedResponse`, `ApiNotFoundResponse`, `ApiBearerAuth`, `ApiApiKey`, `ApiBasicAuth`, `ApiOAuth2`, `ApiCookieAuth`, `ApiSecurity`, `ApiExtraModels`, `ApiExcludeController`, `ApiExcludeEndpoint`, `ApiWebhook`, `getSchemaPath`, `refs`
- **Mapped Types**: `PartialType`, `PickType`, `OmitType`, `IntersectionType`, `CompositionType`, `DeepPartialType`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
