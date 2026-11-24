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
  email!: string;

  @ApiProperty({ example: "Ada Lovelace" })
  name!: string;
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
