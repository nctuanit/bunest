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

## Quản lý phiên bản API (API Versioning)

`@bunest/swagger` tích hợp trực tiếp với [API Versioning](/recipes/versioning) của Bunest trên cả 4 chiến lược (**URI**, **Header**, **Media Type** và **Custom**), hỗ trợ cả lọc tài liệu theo từng phiên bản và giao diện tài liệu đa phiên bản.

### Tự động phát hiện & thiết lập đa phiên bản

Dùng `SwaggerModule.createVersionedDocuments()` để tạo một tài liệu OpenAPI độc lập cho từng phiên bản API được phát hiện, sau đó truyền kết quả vào `SwaggerModule.setup()`:

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

// Tùy chọn: lấy danh sách phiên bản cụ thể (sắp xếp tự nhiên, ví dụ ["1", "2", "10"])
const versions = SwaggerModule.discoverApiVersions(app);

const config = new DocumentBuilder()
  .setTitle("Bunest API")
  .setDescription("Versioned REST API")
  .setVersion("1.0")
  .build();

const docs = SwaggerModule.createVersionedDocuments(app, config, {
  versions, // tùy chọn: tự động phát hiện nếu bỏ qua
  includeVersionNeutral: true,
  infoVersionResolver: (version) => `${version}.0`,
});

SwaggerModule.setup("docs", app, docs, {
  defaultVersion: "2",
  ui: "builtin", // "builtin" | "swagger-ui" | "scalar"
});

await app.listen(3000);
```

Khi `SwaggerModule.setup("docs", app, docs, options)` nhận vào một bản ghi hoặc `Map` các tài liệu theo phiên bản:

- **Endpoint theo từng phiên bản**: tự động đăng ký `/docs/v1-json`, `/docs/v1-yaml`, `/docs/v2-json`, `/docs/v2-yaml` (với mỗi khóa phiên bản `v`, tự thêm tiền tố `v` nếu chưa có).
- **Tài liệu mặc định**: phục vụ `options.defaultVersion` (hoặc phiên bản cuối cùng nếu bỏ qua) tại `/docs-json` và `/docs-yaml` để tương thích ngược.
- **Đăng ký `VERSION_NEUTRAL`**: mọi route UI và đặc tả Swagger đều được gắn `VERSION_NEUTRAL`, nên luôn truy cập được mà không cần prefix hay header phiên bản.
- **Bộ chọn phiên bản tích hợp**: tự động bật trình chuyển đổi phiên bản trên cả 3 preset giao diện—dropdown đồng bộ `?version=...` ở `builtin`, `urls` kèm `StandaloneLayout` ở `swagger-ui`, và `sources` đa tài liệu ở `scalar`.

### Lọc tài liệu theo phiên bản & cô lập Schema

Để tạo một tài liệu OpenAPI duy nhất cho một hoặc nhiều phiên bản cụ thể, truyền `version` và `includeVersionNeutral` (mặc định `true`) vào `SwaggerModule.createDocument()`:

@@filename(main.ts)

```ts
const v1Doc = SwaggerModule.createDocument(app, config, {
  version: "1",
  includeVersionNeutral: true,
});

SwaggerModule.setup("docs/v1", app, v1Doc);
```

Các route được lọc **trước** bước quét schema, vì vậy `components.schemas` chỉ chứa các DTO được tham chiếu bởi phiên bản đã chọn—DTO chỉ dùng ở v2 sẽ không bị rò rỉ sang tài liệu v1.

### Hành vi theo 4 chiến lược Versioning

| Chiến lược | Biểu diễn OpenAPI | Ghi chú |
| --- | --- | --- |
| **URI** (`VersioningType.URI`) | Path có tiền tố phiên bản (ví dụ `/v1/users`, `/v2/users`) | Khi lọc theo `version`, route đa phiên bản (`@Version(["1", "2"])`) chỉ xuất path khớp phiên bản được yêu cầu. |
| **Header** (`VersioningType.HEADER`) | Tự chèn tham số header đã cấu hình với `enum` và `default` theo phạm vi lọc | `required` là `false` khi route là `VERSION_NEUTRAL` hoặc khớp `defaultVersion`; ngược lại là `true`. |
| **Media Type** (`VersioningType.MEDIA_TYPE`) | Tự chèn tham số header `Accept` (ví dụ `application/json;v=2`) với `enum` và `default` theo phạm vi lọc | `required` áp dụng cùng quy tắc `VERSION_NEUTRAL` / `defaultVersion`; Try-It-Out tích hợp gửi đúng header `Accept`. |
| **Custom** (`VersioningType.CUSTOM`) | Truyền `customVersionParameter` để chèn tham số `query`, `header` hoặc `cookie` | Tự động bỏ qua nếu route đã khai báo tường minh tham số đó. |

Với `VersioningType.CUSTOM`, mô tả cách client gửi phiên bản thông qua `customVersionParameter`:

@@filename(main.ts)

```ts
const docs = SwaggerModule.createVersionedDocuments(app, config, {
  customVersionParameter: {
    name: "api-version",
    in: "query", // "query" | "header" | "cookie"
    description: "Tham số query chỉ định phiên bản API",
  },
});
```

> warning **Tránh ghi đè path ở chế độ Header / Media Type / Custom** Ở các chế độ `HEADER`, `MEDIA_TYPE` và `CUSTOM`, các phiên bản khác nhau của một endpoint dùng chung path và HTTP method (ví dụ `GET /users`). Nếu tạo một tài liệu đơn không lọc, phiên bản sau sẽ ghi đè phiên bản trước và ghi cảnh báo xung đột—hãy dùng `SwaggerModule.createVersionedDocuments()` hoặc `SwaggerModule.createDocument(app, config, { version })` để tách biệt từng phiên bản.

## Các hàm Mapped DTO Helpers

Tạo các lớp DTO mới từ DTO có sẵn mà vẫn giữ nguyên metadata `@ApiProperty()` và các quy tắc kiểm tra `@bunest/validation`. `@bunest/swagger` export 6 hàm mapped-type:

- `PartialType(Class)` — đánh dấu tất cả thuộc tính là tùy chọn.
- `PickType(Class, keys)` — chỉ giữ lại các thuộc tính được chọn.
- `OmitType(Class, keys)` — loại bỏ các thuộc tính chỉ định.
- `IntersectionType(ClassA, ClassB)` — kết hợp thuộc tính từ hai DTO.
- `DeepPartialType(Class)` — đệ quy đánh dấu mọi thuộc tính DTO lồng nhau là tùy chọn.
- `CompositionType(...Classes)` — kết hợp nhiều lớp DTO thành một lớp duy nhất.

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

## Tích hợp Standard Schema

Các route validate bằng `@UseStandardSchema(schema)` (từ `@bunest/core` hoặc `@bunest/validation`) sẽ tự động sinh OpenAPI schema khi schema hỗ trợ **Standard JSON Schema v1** (`~standard.jsonSchema`, như Zod v4+, Valibot hoặc ArkType) thông qua `defaultStandardSchemaConverter` tích hợp sẵn.

Với thư viện chưa hỗ trợ Standard JSON Schema hoặc cần logic chuyển đổi riêng, truyền `standardSchemaConverter` tùy chỉnh vào `SwaggerModule.createDocument()`:

@@filename(main.ts)

```ts
import { Body, Controller, Post, UseStandardSchema } from "@bunest/core";
import {
  defaultStandardSchemaConverter,
  SwaggerModule,
} from "@bunest/swagger";

// Converter tùy chỉnh có thể fallback về converter Standard JSON Schema v1 mặc định
const document = SwaggerModule.createDocument(app, config, {
  standardSchemaConverter: (schema, options) =>
    defaultStandardSchemaConverter(schema, options),
});
```

## Tự động suy luận Schema từ `@Entity()` & `@Column()`

`SchemaExplorer` tự động suy luận các lớp `@Entity()` gắn `@Column()`, `@PrimaryGeneratedColumn()`, `@PrimaryKey()`, `@CreateDateColumn()` và `@UpdateDateColumn()`—ánh xạ kiểu dữ liệu SQL/ORM, `minLength`/`maxLength`, `min`/`max`, `pattern`, `enum`, `default`, `nullable` và `description` trực tiếp sang thuộc tính OpenAPI schema.

- Các cột đánh dấu `{ select: false }` (như `passwordHash`) được tự động ẩn khỏi OpenAPI schema sinh ra.
- Các decorator tường minh như `@ApiProperty()`, `@ApiHideProperty()` và `@ApiSchema()` sẽ ghi đè metadata suy luận từ entity khi cần.

@@filename(account.entity.ts)

```ts
import { Column, Entity, PrimaryGeneratedColumn } from "@bunest/core";

@Entity({ tableName: "accounts", description: "Tài khoản người dùng" })
export class AccountEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ minLength: 3, maxLength: 120, description: "Tên hiển thị" })
  name!: string;

  @Column({ select: false })
  passwordHash!: string; // Tự động ẩn khỏi OpenAPI schema
}
```

## Plugin Metadata lúc Build (CLI)

Để tự động điền schema thuộc tính DTO và metadata của controller mà không cần viết lặp `@ApiProperty()` thủ công, sinh tệp metadata lúc build bằng CLI rồi nạp qua `SwaggerModule.loadPluginMetadata()` trước khi gọi `SwaggerModule.createDocument()`:

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
