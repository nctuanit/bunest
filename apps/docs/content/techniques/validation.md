# Validation

`@bunest/validation` provides production-hardened DTO validation powered by **`class-validator` + `class-transformer`** as the default (`ValidationPipe`, [ADR-005](/architecture/adrs) & [ADR-009](/architecture/adrs)), plus a first-class **`SchemaValidationPipe`** adapter for **Zod, Valibot, TypeBox**, or custom schema validators!

## Enabling `ValidationPipe`

Bind `ValidationPipe` globally, on a controller/method (`@UsePipes`), or on a single parameter (`@Body(new ValidationPipe())`):

@@filename(main.ts)
```ts
import "reflect-metadata";
import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe());
await app.listen(3000);
```

> info **Opt-In Execution (ADR-005)** `class-validator` decorators (`@IsEmail()`, `@MinLength()`) only register metadata—they do **not** validate incoming requests unless a `ValidationPipe` is attached. Endpoints without DTOs or without `ValidationPipe` pay zero validation overhead.

## Writing Validated DTOs

Use `class-validator` constraints and explicit `@Type()` from `class-transformer` for nested DTOs, arrays, and explicit numeric conversions:

@@filename(create-order.dto.ts)
```ts
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

export class OrderItemDto {
  @IsString()
  sku!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CreateOrderDto {
  @IsEmail()
  customerEmail!: string;

  @IsString()
  @MinLength(2)
  customerName!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @IsOptional()
  @IsString()
  promoCode?: string;
}
```

## Secure-by-Default `ValidationPipeOptions` (ADR-009)

Unlike permissive defaults that risk mass-assignment or silent type coercion bugs, Bunest's `new ValidationPipe()` ships with strict, security-first defaults:

| Option | Default | Why |
|---|---|---|
| `whitelist` | `true` | Strips undecorated properties (prevents mass assignment) |
| `forbidNonWhitelisted` | `true` | Rejects unexpected fields with HTTP 400 instead of silently ignoring them |
| `forbidUnknownValues` | `true` | Prevents non-object or decorator-less payloads from passing as empty valid DTOs |
| `transform` | `true` | Converts plain JSON to a real DTO instance via `plainToInstance()` |
| `transformOptions.enableImplicitConversion` | `false` | **Explicit transform policy** — never turns `"false"` into `true` |
| `validationError.target` | `false` | Omits full DTO from errors (never echoes passwords/secrets) |
| `validationError.value` | `false` | Omits raw rejected input from errors (never echoes PII) |
| `stopAtFirstError` | `false` | Returns all field violations in a single response |
| `errorHttpStatusCode` | `400` | Throws `BadRequestException` (overrideable, e.g. `422`) |

> warning **Prototype Pollution Guard** Before running `plainToInstance()`, both `ValidationPipe` and `SchemaValidationPipe` scan payloads for dangerous own keys (`__proto__`, `constructor`, `prototype`) using `findDangerousKeys()` and reject them with HTTP 400!

## Normalized HTTP 400 Error Format

Nested objects and array items are automatically flattened into deterministic dot/bracket field paths (`address.zipCode`, `items[0].quantity`). Raw `class-validator` `ValidationError` trees are never leaked directly:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": [
    {
      "field": "customerEmail",
      "constraints": {
        "isEmail": "customerEmail must be an email"
      },
      "messages": ["customerEmail must be an email"]
    },
    {
      "field": "items[0].quantity",
      "constraints": {
        "min": "quantity must not be less than 1"
      },
      "messages": ["quantity must not be less than 1"]
    },
    {
      "field": "isAdmin",
      "constraints": {
        "whitelistValidation": "property isAdmin should not exist"
      },
      "messages": ["property isAdmin should not exist"]
    }
  ],
  "timestamp": "2026-11-20T03:00:00.000Z",
  "path": "/orders"
}
```

## Using Zod / Valibot with `SchemaValidationPipe`

Prefer schema-first validation? `SchemaValidationPipe` adapts any `SchemaValidator<T>` implementing `parse`, `parseAsync`, `safeParse`, or `safeParseAsync`—automatically normalizing issues into the **exact same ADR-009 HTTP 400 format** and enforcing prototype-pollution protection!

@@filename(create-user.controller.ts)
@@tab(class-validator DTO)
```ts
import { Body, Controller, Post, UsePipes } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { CreateUserDto } from "./create-user.dto";

@Controller("users")
export class UsersController {
  @Post()
  @UsePipes(new ValidationPipe())
  create(@Body() dto: CreateUserDto) {
    return dto;
  }
}
```
@@switch
@@tab(Zod / SchemaValidationPipe)
```ts
import { Body, Controller, Post } from "@bunest/core";
import { SchemaValidationPipe } from "@bunest/validation";
import { z } from "zod";

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(3),
});

type CreateUserInput = z.infer<typeof createUserSchema>;

@Controller("users")
export class UsersController {
  @Post()
  create(
    @Body(new SchemaValidationPipe(createUserSchema))
    dto: CreateUserInput,
  ) {
    return dto;
  }
}
```
