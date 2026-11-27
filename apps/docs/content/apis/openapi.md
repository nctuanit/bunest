# OpenAPI (Swagger)

**`@bunest/swagger`** provides 100% `@nestjs/swagger` v12 API parity (**160/160** exports) for generating **OpenAPI 3.1** specifications directly from your controllers, DTOs, mapped types (`PartialType`/`PickType`/`OmitType`/`IntersectionType`), and `@Version()` routes—plus a built-in zero-dependency Interactive Try-It-Out UI (and Scalar / Swagger UI presets).

## Installation

```bash
bun add @bunest/swagger
```

## Bootstrap Setup

Build an OpenAPI document with `DocumentBuilder` and mount it with `SwaggerModule.setup()`:

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);

const config = new DocumentBuilder()
  .setTitle("Bunest API")
  .setDescription("REST API documentation")
  .setVersion("1.0")
  .addBearerAuth()
  .build();

const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup("docs", app, document);

await app.listen(3000);
// Interactive UI: http://localhost:3000/docs
// OpenAPI JSON:   http://localhost:3000/docs-json
```

## Decorating Controllers & DTOs

@@filename(users.controller.ts)

```ts
import { Body, Controller, Get, Param, Post } from "@bunest/core";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from "@bunest/swagger";

export class CreateUserDto {
  @ApiProperty({ example: "ada@example.com" })
  email: string;

  @ApiProperty({ example: "Ada Lovelace" })
  name: string;
}

@ApiTags("users")
@ApiBearerAuth()
@Controller("users")
export class UsersController {
  @Get(":id")
  @ApiOperation({ summary: "Get user by ID" })
  @ApiOkResponse({ type: CreateUserDto })
  @ApiNotFoundResponse({ description: "User not found" })
  findOne(@Param("id") id: string) {
    return { id };
  }

  @Post()
  @ApiCreatedResponse({ type: CreateUserDto })
  create(@Body() dto: CreateUserDto) {
    return dto;
  }
}
```

## API Versioning

`@bunest/swagger` integrates directly with Bunest's [API Versioning](/recipes/versioning) across all four strategies (**URI**, **Header**, **Media Type**, and **Custom**), supporting both per-version document filtering and multi-version interactive docs.

### Multi-Version Discovery & Setup

Use `SwaggerModule.createVersionedDocuments()` to generate one isolated OpenAPI document per discovered API version, then pass the resulting map to `SwaggerModule.setup()`:

@@filename(main.ts)

```ts
import { BunestFactory, VersioningType } from "@bunest/core";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);

app.enableVersioning({
  type: VersioningType.URI,
  defaultVersion: "1",
});

// Optional: inspect discovered concrete versions (naturally sorted, e.g. ["1", "2", "10"])
const versions = SwaggerModule.discoverApiVersions(app);

const config = new DocumentBuilder()
  .setTitle("Bunest API")
  .setDescription("Versioned REST API")
  .setVersion("1.0")
  .build();

const docs = SwaggerModule.createVersionedDocuments(app, config, {
  versions, // optional: auto-discovered when omitted
  includeVersionNeutral: true,
  infoVersionResolver: (version) => `${version}.0`,
});

SwaggerModule.setup("docs", app, docs, {
  defaultVersion: "2",
  ui: "builtin", // "builtin" | "swagger-ui" | "scalar"
});

await app.listen(3000);
```

When `SwaggerModule.setup("docs", app, docs, options)` receives a versioned document record or `Map`:

- **Per-version specs**: registers `/docs/v1-json`, `/docs/v1-yaml`, `/docs/v2-json`, `/docs/v2-yaml` (for each version key `v`, prefixed with `v` unless already starting with `v`).
- **Default spec**: serves `options.defaultVersion` (or the last version when omitted) at `/docs-json` and `/docs-yaml` for backwards compatibility.
- **Version-neutral mounting**: all Swagger UI and spec routes are registered with `VERSION_NEUTRAL`, so they remain reachable without version prefixes or headers.
- **Built-in version selector**: automatically enables a version switcher across all three UI presets—an interactive dropdown (`?version=...` synced) in `builtin`, `urls` with `StandaloneLayout` in `swagger-ui`, and multi-document `sources` in `scalar`.

### Per-Version Filtering & Schema Scoping

To generate a single OpenAPI document scoped to one or more specific versions, pass `version` and `includeVersionNeutral` (defaults to `true`) to `SwaggerModule.createDocument()`:

@@filename(main.ts)

```ts
const v1Doc = SwaggerModule.createDocument(app, config, {
  version: "1",
  includeVersionNeutral: true,
});

SwaggerModule.setup("docs/v1", app, v1Doc);
```

Routes are filtered **before** schema exploration, so `components.schemas` only includes DTOs referenced by the selected version(s)—v2-only DTOs never leak into a v1 document.

### Behavior Across Versioning Strategies

| Strategy | OpenAPI Representation | Notes |
| --- | --- | --- |
| **URI** (`VersioningType.URI`) | Version-prefixed paths (e.g. `/v1/users`, `/v2/users`) | With `version` filtering, multi-version routes (`@Version(["1", "2"])`) only emit paths matching the requested version. |
| **Header** (`VersioningType.HEADER`) | Injects the configured header parameter with scoped `enum` and `default` | `required` is `false` when the route is `VERSION_NEUTRAL` or matches `defaultVersion`; otherwise `true`. |
| **Media Type** (`VersioningType.MEDIA_TYPE`) | Injects the `Accept` header parameter (e.g. `application/json;v=2`) with scoped `enum` and `default` | `required` follows the same `VERSION_NEUTRAL` / `defaultVersion` rules; built-in Try-It-Out sends the `Accept` header. |
| **Custom** (`VersioningType.CUSTOM`) | Pass `customVersionParameter` to inject a `query`, `header`, or `cookie` parameter | Skipped automatically if the route already declares that parameter explicitly. |

For `VersioningType.CUSTOM`, describe how clients send the version via `customVersionParameter`:

@@filename(main.ts)

```ts
const docs = SwaggerModule.createVersionedDocuments(app, config, {
  customVersionParameter: {
    name: "api-version",
    in: "query", // "query" | "header" | "cookie"
    description: "API version query parameter",
  },
});
```

> warning **Preventing Path Overwrites in Header / Media Type / Custom Modes** In `HEADER`, `MEDIA_TYPE`, and `CUSTOM` modes, different versions of an endpoint share the same OpenAPI path and HTTP method (for example, `GET /users`). Generating a single unfiltered document causes later versions to overwrite earlier ones and logs a collision warning—use `SwaggerModule.createVersionedDocuments()` or `SwaggerModule.createDocument(app, config, { version })` to keep every version isolated.

## Mapped DTO Helpers

Derive new DTO classes from existing ones while preserving both `@ApiProperty()` metadata and `@bunest/validation` rules. `@bunest/swagger` exports six mapped-type helpers:

- `PartialType(Class)` — marks all properties optional.
- `PickType(Class, keys)` — keeps only the selected properties.
- `OmitType(Class, keys)` — excludes the specified properties.
- `IntersectionType(ClassA, ClassB)` — combines properties from two DTOs.
- `DeepPartialType(Class)` — recursively marks nested DTO properties optional.
- `CompositionType(...Classes)` — composes multiple DTOs into a single class.

@@filename(user.dtos.ts)

```ts
import {
  CompositionType,
  DeepPartialType,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
} from "@bunest/swagger";
import { CreateUserDto } from "./users.controller";

export class UpdateUserDto extends PartialType(CreateUserDto) {}
export class PublicUserDto extends OmitType(CreateUserDto, ["email"] as const) {}
export class UserEmailDto extends PickType(CreateUserDto, ["email"] as const) {}
export class DeepUpdateUserDto extends DeepPartialType(CreateUserDto) {}
export class CombinedUserDto extends IntersectionType(PublicUserDto, UserEmailDto) {}
export class ComposedUserDto extends CompositionType(PublicUserDto, UserEmailDto) {}
```

## Standard Schema Integration

Routes validated with `@UseStandardSchema(schema)` (from `@bunest/core` or `@bunest/validation`) are automatically reflected into OpenAPI schemas whenever the schema implements **Standard JSON Schema v1** (`~standard.jsonSchema`, such as Zod v4+, Valibot, or ArkType) via the built-in `defaultStandardSchemaConverter`.

For libraries without native Standard JSON Schema support or custom conversion logic, pass a custom `standardSchemaConverter` to `SwaggerModule.createDocument()`:

@@filename(main.ts)

```ts
import { Body, Controller, Post, UseStandardSchema } from "@bunest/core";
import {
  defaultStandardSchemaConverter,
  SwaggerModule,
} from "@bunest/swagger";

// Custom converter falls back to the built-in Standard JSON Schema v1 converter
const document = SwaggerModule.createDocument(app, config, {
  standardSchemaConverter: (schema, options) =>
    defaultStandardSchemaConverter(schema, options),
});
```

## Entity & Column Introspection

`SchemaExplorer` automatically introspects `@Entity()` classes decorated with `@Column()`, `@PrimaryGeneratedColumn()`, `@PrimaryKey()`, `@CreateDateColumn()`, and `@UpdateDateColumn()`—mapping SQL/ORM types, `minLength`/`maxLength`, `min`/`max`, `pattern`, `enum`, `default`, `nullable`, and `description` directly to OpenAPI schema properties.

- Columns marked `{ select: false }` (such as `passwordHash`) are automatically hidden from generated OpenAPI schemas.
- Explicit `@ApiProperty()` / `@ApiHideProperty()` / `@ApiSchema()` decorators override inferred entity metadata when needed.

@@filename(account.entity.ts)

```ts
import { Column, Entity, PrimaryGeneratedColumn } from "@bunest/core";

@Entity({ tableName: "accounts", description: "User account" })
export class AccountEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ minLength: 3, maxLength: 120, description: "Display name" })
  name!: string;

  @Column({ select: false })
  passwordHash!: string; // Automatically excluded from OpenAPI schemas
}
```

## Build-Time CLI Metadata Plugin

To populate DTO property schemas and controller operation metadata without writing repetitive `@ApiProperty()` decorators by hand, generate a build-time metadata file with the CLI and register it via `SwaggerModule.loadPluginMetadata()` before calling `SwaggerModule.createDocument()`:

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import { AppModule } from "./app.module";
import metadata from "./metadata";

const app = await BunestFactory.create(AppModule);

await SwaggerModule.loadPluginMetadata(metadata);

const config = new DocumentBuilder().setTitle("Bunest API").setVersion("1.0").build();
const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup("docs", app, document);
```
