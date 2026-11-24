# Mapped Types

Bunest provides built-in `@nestjs/mapped-types` v12 parity directly in **`@bunest/validation`** (also re-exported from **`@bunest/core`**) for deriving DTO classes from existing DTOs while preserving `@bunest/validation` (and upstream `class-validator`/`class-transformer`) and OpenAPI metadata.

## Installation

```bash
bun add @bunest/validation
```

## Available Helpers

| Helper                      | Description                                                                   |
| --------------------------- | ----------------------------------------------------------------------------- |
| `PartialType(BaseDto)`      | Makes all properties optional and applies `@IsOptional()` validation metadata |
| `PickType(BaseDto, keys)`   | Picks a subset of properties and their validation/transformation metadata     |
| `OmitType(BaseDto, keys)`   | Omits specified properties while preserving all remaining metadata            |
| `IntersectionType(...Dtos)` | Combines two or more DTO classes into a single class (variadic)               |
| `CompositionType(...Dtos)`  | Composes multiple DTO classes with full metadata inheritance                  |

## Usage

@@filename(user.dto.ts)

```ts
import { IsEmail, IsString, MinLength } from "@bunest/validation/validator";
import {
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
} from "@bunest/validation";

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  name!: string;
}

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ["password"] as const),
) {}

export class LoginDto extends PickType(CreateUserDto, [
  "email",
  "password",
] as const) {}

export class AuditMetaDto {
  @IsString()
  reason!: string;
}

export class AuditedUpdateUserDto extends IntersectionType(
  UpdateUserDto,
  AuditMetaDto,
) {}
```

> info **Swagger Integration** `@bunest/swagger` automatically introspects classes created with `PartialType`, `PickType`, `OmitType`, and `IntersectionType` when generating OpenAPI 3.1 schemas.
