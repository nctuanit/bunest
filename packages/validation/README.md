# @bunest/validation

Zero-external-dependency, compile-once Bun-native DTO validator (**336/336** `class-validator` API parity), class transformer (**21/21** `class-transformer` API parity), `ValidationPipe`, `ClassSerializerInterceptor`, Standard Schema adapters, and prototype-pollution sanitization for **Bunest** ([ADR-015](../../docs/adr/ADR-015.md), [ADR-016](../../docs/adr/ADR-016.md)).

## Features

- **Zero-Dep Compile-Once Validator (`@bunest/validation/validator`):** Full drop-in API parity (~105 built-in linear-time ReDoS-safe validators + `registerPhoneNumberValidator` + UUIDv7), `WeakMap`-cached compilation plans, single-realm `Symbol.for("bunest:class-validator:storage")`, and a zero-Promise sync fast-path fused directly into `ValidationPipe`.
- **Zero-Dep Compile-Once Transformer (`@bunest/validation/transformer`):** Full drop-in API parity (`plainToInstance`, `instanceToPlain`, `instanceToInstance`, `@Expose`, `@Exclude`, `@Type` + polymorphic `discriminator`, `@Transform`, method decorators), prototype-pollution immunity by construction, Web/Bun built-in preservation, and safe `enableImplicitConversion`.
- **Seamless Dual-Engine Coexistence:** DTOs decorated with `@bunest/validation/validator` + `@bunest/validation/transformer` execute on the native Bun engine, while existing NestJS DTOs using upstream `class-validator` / `class-transformer` continue working side-by-side automatically when installed.
- **Standard Schema & Custom Schema Pipes (`@bunest/validation/standard-schema`):** Validate and serialize with Zod, Valibot, ArkType, or any Standard Schema v1 library via `StandardSchemaValidationPipe`, `SchemaValidationPipe`, and `StandardSchemaSerializerInterceptor`.
- **Entity & Mapped-Type Utilities:** `validateEntity()`, `PartialType`, `PickType`, `OmitType`, `IntersectionType`, and `CompositionType` with automatic metadata cloning.

## Installation

```bash
bun add @bunest/validation
```

*(Zero external npm runtime dependencies — no need to install `class-validator` or `class-transformer`!)*

## Quick Start

```ts
import "reflect-metadata";
import { Body, BunestFactory, Controller, Module, Post } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { IsEmail, IsString, MinLength } from "@bunest/validation/validator";
import { Exclude, Expose, Transform } from "@bunest/validation/transformer";

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  password!: string;
}

export class UserResponse {
  @Expose()
  email!: string;

  @Exclude()
  password!: string;
}

@Controller("users")
export class UsersController {
  @Post()
  create(@Body() dto: CreateUserDto) {
    return { email: dto.email };
  }
}

@Module({ controllers: [UsersController] })
export class AppModule {}

const app = await BunestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe());
await app.listen(3000);
```

## Subpath Exports

- **`@bunest/validation`** — `ValidationPipe`, `ClassSerializerInterceptor`, `SchemaValidationPipe`, `StandardSchemaValidationPipe`, `StandardSchemaSerializerInterceptor`, `PartialType`/`PickType`/`OmitType`/`IntersectionType`/`CompositionType`, `validateEntity`, sanitization & error-formatting helpers
- **`@bunest/validation/validator`** — Zero-dep Bun-native validator engine (`validate`, `validateSync`, `validateOrReject`, `Validator`, `ValidationError`, `MetadataStorage`, `getMetadataStorage`, `registerDecorator`, `registerSchema`, `ValidateBy`, `canValidateSynchronously`, `registerPhoneNumberValidator`, and all ~105 built-in validators)
- **`@bunest/validation/transformer`** — Zero-dep Bun-native transformer engine (`plainToInstance`, `instanceToPlain`, `instanceToInstance`, `serialize`, `deserialize`, `deserializeArray`, `ClassTransformer`, `@Expose`, `@Exclude`, `@Type`, `@Transform`, method decorators, `getMetadataStorage`)
- **`@bunest/validation/standard-schema`** — `StandardSchemaValidationPipe`, `StandardSchemaSerializerInterceptor`, `UseStandardSchema`, `formatStandardSchemaIssues`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR-015: Bun-Native DTO Validation & Transformation Engine](../../docs/adr/ADR-015.md)
- [ADR-016: 37 → 19 Package Consolidation & Bun 1.4.5 Native API Alignment](../../docs/adr/ADR-016.md)
