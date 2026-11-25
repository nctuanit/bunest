# OpenAPI (Swagger)

**`@bunest/swagger`** cung cấp độ tương thích API 100% với `@nestjs/swagger` v12 (**160/160** export) để tạo đặc tả **OpenAPI 3.1** trực tiếp từ controller, DTO, mapped types (`PartialType`/`PickType`/`OmitType`/`IntersectionType`) và các route `@Version()`—kèm theo giao diện Interactive Try-It-Out UI tích hợp sẵn không phụ thuộc thư viện ngoài (và các preset Scalar / Swagger UI).

## Cài đặt

```bash
bun add @bunest/swagger
```

## Thiết lập khi khởi động

Xây dựng tài liệu OpenAPI bằng `DocumentBuilder` và gắn vào ứng dụng với `SwaggerModule.setup()`:

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

## Gắn Decorator cho Controller & DTO

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
