# Pipes

A pipe is a class implementing the `PipeTransform` interface. Pipes execute at **Stage 8** of the execution pipeline—right after parameter extraction and before invoking the controller handler—and serve two core purposes:

1. **Transformation** — convert raw input strings into desired types (e.g., `"42"` to `42`, `"true"` to `true`, or plain JSON to a DTO class instance).
2. **Validation** — evaluate input data and throw `BadRequestException` (400) if invalid, preventing the handler from ever running.

> info **No Implicit Coercion** Query strings, path params, headers, and cookies always arrive as `string` (or `string[]`). Bunest **never** silently runs `Boolean("false") === true` or implicit numeric coercion—use explicit built-in pipes or `ValidationPipe` with `@Type()`.

## Built-in Parse Pipes

Bunest includes 7 built-in pipes:

| Pipe               | Purpose                                                          | Example Input &rarr; Output                        |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------------------- |
| `ParseIntPipe`     | Strict base-10 integer parsing                                   | `"42"` &rarr; `42` (rejects `"42px"`, `"3.14"`)    |
| `ParseFloatPipe`   | Strict finite float parsing                                      | `"3.14"` &rarr; `3.14` (rejects `NaN`, `Infinity`) |
| `ParseBoolPipe`    | Strict boolean string parsing                                    | `"true"` / `"false"` &rarr; `true` / `false`       |
| `ParseUUIDPipe`    | RFC 4122 UUID validation (`version?: "3"\|"4"\|"5"\|"7"\|"all"`) | `"550e8400-..."` &rarr; validated string           |
| `ParseEnumPipe`    | Validates membership in a TS `enum` / object                     | `"ADMIN"` &rarr; `Role.ADMIN`                      |
| `ParseArrayPipe`   | Splits & parses CSV / repeated values                            | `"1,2,3"` &rarr; `[1, 2, 3]`                       |
| `DefaultValuePipe` | Supplies fallback when `undefined` / `null` / `""`               | `undefined` &rarr; `1`                             |

## Binding Parameter Pipes

Pass pipe classes or configured instances directly to `@Param()`, `@Query()`, `@Body()`, or `@Headers()`:

@@filename(items.controller.ts)

```ts
import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpStatus,
  Param,
  ParseArrayPipe,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
} from "@bunest/core";

@Controller("items")
export class ItemsController {
  @Get(":id")
  findOne(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Query("includeDeleted", new DefaultValuePipe(false), ParseBoolPipe)
    includeDeleted: boolean,
  ) {
    return { id, includeDeleted };
  }

  @Get("page/:page")
  paginate(
    @Param(
      "page",
      new ParseIntPipe({ errorHttpStatusCode: HttpStatus.NOT_ACCEPTABLE }),
    )
    page: number,
    @Query(
      "tags",
      new ParseArrayPipe({ items: String, separator: ",", optional: true }),
    )
    tags?: string[],
  ) {
    return { page, tags: tags ?? [] };
  }
}
```

## Chaining & Precedence

When multiple pipes apply to a single parameter, they run sequentially—the output of pipe `i` becomes the input `value` to pipe `i + 1`:

```text
Global (APP_PIPE / useGlobalPipes) -> Controller (@UsePipes) -> Method (@UsePipes) -> Parameter (@Param / @Query / @Body)
```

Global, controller, and method validation pipes automatically skip raw framework objects injected via `@Req()` and `@Res()`.

## Writing a Custom Pipe

Implement `PipeTransform<T, R>` to build your own transformation or validation logic:

@@filename(trim.pipe.ts)

```ts
import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from "@bunest/core";

@Injectable()
export class TrimNonEmptyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, metadata: ArgumentMetadata): string {
    if (typeof value !== "string") {
      throw new BadRequestException(
        `${metadata.data ?? "value"} must be a string`,
      );
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(
        `${metadata.data ?? "value"} must not be empty`,
      );
    }
    return trimmed;
  }
}
```

For full class-based DTO validation (`ValidationPipe`) and Zod/Valibot adapters (`SchemaValidationPipe`), continue to [Validation](/techniques/validation).
