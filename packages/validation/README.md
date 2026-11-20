# @bunest/validation

DTO validation pipes, class serializer interceptor, Standard Schema adapters, and prototype-pollution sanitization for **Bunest**.

## Features

- **Class-Validator & Class-Transformer Pipe**: `ValidationPipe` supports `whitelist`, `forbidNonWhitelisted`, `transform`, `transformOptions`, custom `exceptionFactory`, and error truncation (`DEFAULT_MAX_ERROR_MESSAGES_LENGTH`).
- **Standard Schema & Custom Schema Pipes**: Validate with Zod, Valibot, ArkType, or any Standard Schema v1 library via `StandardSchemaValidationPipe` and `SchemaValidationPipe`.
- **Response Serialization**: `ClassSerializerInterceptor` (`@SerializeOptions()`) and `StandardSchemaSerializerInterceptor` (`@UseStandardSchema()`).
- **Entity & Mapped-Type Hooks**: `validateEntity()` for domain/ORM entity validation and automatic `class-transformer` metadata cloning for `@bunest/mapped-types`.
- **Prototype Pollution Guard**: `findDangerousKeys()`, `stripDangerousKeys()`, and `DANGEROUS_PROTOTYPE_KEYS` defend against `__proto__`, `constructor`, and `prototype` payload attacks.

## Installation

```bash
bun add @bunest/validation class-validator class-transformer
```

## Quick Start

```ts
import { Body, Controller, Module, Post } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { IsEmail, IsString, MinLength } from "class-validator";

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
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
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
await app.listen(3000);
```

## Key Exports

- **Validation Pipes**: `ValidationPipe`, `SchemaValidationPipe`, `StandardSchemaValidationPipe`, `VALIDATION_PIPE_OPTIONS`
- **Serialization Interceptors & Decorators**: `ClassSerializerInterceptor`, `SerializeOptions`, `CLASS_SERIALIZER_OPTIONS`, `StandardSchemaSerializerInterceptor`, `UseStandardSchema`, `STANDARD_SCHEMA_SERIALIZER_METADATA`
- **Entity & Hook Utilities**: `validateEntity`, `classTransformerMappedTypeHook`, `registerClassTransformerMappedTypeHook`
- **Formatting & Sanitization**: `flattenValidationErrors`, `formatValidationErrorResponse`, `formatStandardSchemaIssues`, `formatStandardSchemaPath`, `findDangerousKeys`, `stripDangerousKeys`, `DANGEROUS_PROTOTYPE_KEYS`, `DEFAULT_MAX_ERROR_MESSAGES_LENGTH`, `OMITTED_ERRORS_MESSAGE`, `resolveMaxErrorMessagesLength`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
