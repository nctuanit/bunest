# @bunest/mapped-types

Drop-in NestJS `@nestjs/mapped-types` equivalent for **Bunest**. Provides DTO composition utilities that clone `class-validator`, `class-transformer`, `@bunest/swagger`, and `reflect-metadata` rules without mutating base DTO classes.

## Features

- **DTO Transformation Helpers**: `PartialType`, `PickType`, `OmitType`, `IntersectionType`, and `CompositionType` with full TypeScript type inference.
- **Metadata Preservation**: Automatically inherits `class-validator` rules, `class-transformer` decorators (`@Type`, `@Expose`, `@Exclude`, `@Transform`), `@ApiProperty` metadata, property initializers, and `design:type` reflection metadata.
- **Extensible Hook System**: Register custom metadata cloning hooks via `registerMappedTypeMetadataHook()`.
- **Non-Mutating**: Always generates new derived classes so base DTOs remain untouched.

## Installation

```bash
bun add @bunest/mapped-types
```

## Quick Start

```ts
import { PartialType, PickType, OmitType, IntersectionType } from "@bunest/mapped-types";
import { IsEmail, IsString, MinLength } from "class-validator";

export class CreateUserDto {
  @IsString()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ["password"] as const),
) {}

export class LoginDto extends PickType(CreateUserDto, ["email", "password"] as const) {}
```

## Key Exports

- **Mapped Type Helpers**: `PartialType`, `PickType`, `OmitType`, `IntersectionType`, `CompositionType`
- **Metadata & Decorator Utilities**: `applyIsOptionalDecorator`, `applyValidateIfDefinedDecorator`, `inheritPropertyInitializers`, `inheritTransformationMetadata`, `inheritValidationMetadata`, `registerMappedTypeMetadataHook`
- **Types**: `MappedType`, `MappedTypeMetadataHook`, `MappedTypeOperation`, `RemoveFieldsWithType`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
