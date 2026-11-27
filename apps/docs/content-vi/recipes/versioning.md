# Quản lý phiên bản API (API Versioning)

Bunest hỗ trợ đầy đủ 4 chiến lược versioning của NestJS v12 — **URI**, **Header**, **Media Type** và **Custom** — được biên dịch trực tiếp vào bảng route lúc khởi động nên không tốn chi phí reflection cho mỗi request.

## Kích hoạt Versioning

Gọi `app.enableVersioning(...)` trước khi gọi `app.listen()`:

@@filename(main.ts)

```ts
import { BunestFactory, VersioningType } from "@bunest/core";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);

app.enableVersioning({
  type: VersioningType.URI,
  defaultVersion: "1",
});

await app.listen(3000);
```

## 4 Chiến lược Versioning

| Chiến lược | Enum | Ví dụ Request | Cấu hình |
| --- | --- | --- | --- |
| **URI** | `VersioningType.URI` | `GET /v1/users`, `GET /v2/users` | `{ type: VersioningType.URI, prefix: "v" }` |
| **Header** | `VersioningType.HEADER` | `X-API-Version: 2` | `{ type: VersioningType.HEADER, header: "X-API-Version" }` |
| **Media Type** | `VersioningType.MEDIA_TYPE` | `Accept: application/json;v=2` | `{ type: VersioningType.MEDIA_TYPE, key: "v=" }` |
| **Custom** | `VersioningType.CUSTOM` | Bất kỳ header, cookie, subdomain hay query | `{ type: VersioningType.CUSTOM, extractor: (req) => ... }` |

### Ví dụ Custom Extractor

@@filename(main.ts)

```ts
app.enableVersioning({
  type: VersioningType.CUSTOM,
  extractor: (request) => {
    const url = new URL(request.url);
    return url.searchParams.get("api-version") ?? "1";
  },
});
```

## Phiên bản ở mức Controller và Route

Gắn `@Controller({ path, version })` cho cả controller, hoặc ghi đè bằng `@Version()` trên từng handler cụ thể:

@@filename(users.controller.ts)

```ts
import { Controller, Get, Version, VERSION_NEUTRAL } from "@bunest/core";

@Controller({ path: "users", version: "1" })
export class UsersController {
  @Get()
  findAllV1() {
    return [{ id: 1, name: "Ada" }];
  }

  // Ghi đè phiên bản controller: phục vụ tại /v2/users
  @Version("2")
  @Get()
  findAllV2() {
    return {
      data: [{ id: 1, fullName: "Ada Lovelace" }],
      meta: { total: 1 },
    };
  }

  // Phục vụ đồng thời /v1/users/profile và /v2/users/profile
  @Version(["1", "2"])
  @Get("profile")
  getProfile() {
    return { active: true };
  }

  // Không phụ thuộc phiên bản (ví dụ /users/health)
  @Version(VERSION_NEUTRAL)
  @Get("health")
  health() {
    return { ok: true };
  }
}
```

## Kiểm tra trùng lặp route lúc khởi động

Router fail-fast của Bunest kiểm tra trùng lặp route kèm phiên bản (`BUNEST_E101`). Hai handler cùng HTTP method và path sẽ **hợp lệ** nếu khác phiên bản (`@Version("1")` vs `@Version("2")`), và báo lỗi ngay nếu trùng phiên bản.

## Tích hợp OpenAPI & Swagger

[`@bunest/swagger`](/apis/openapi) hỗ trợ tạo tài liệu OpenAPI 3.1 đa phiên bản đầy đủ cho cả 4 chiến lược versioning:

@@filename(main.ts)

```ts
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";

const config = new DocumentBuilder()
  .setTitle("Users API")
  .setVersion("1.0")
  .build();

// Tự động phát hiện phiên bản (qua SwaggerModule.discoverApiVersions(app))
const docs = SwaggerModule.createVersionedDocuments(app, config, {
  includeVersionNeutral: true,
});

SwaggerModule.setup("docs", app, docs, {
  defaultVersion: "2",
});
```

- **Các endpoint được tạo**: phục vụ `/docs/v1-json`, `/docs/v1-yaml`, `/docs/v2-json`, `/docs/v2-yaml`, kèm `/docs-json` và `/docs-yaml` cho `defaultVersion` (hoặc phiên bản mới nhất). Mọi route tài liệu đều được đăng ký ở chế độ `VERSION_NEUTRAL`.
- **Bộ chuyển phiên bản**: tự động kích hoạt trên cả 3 preset giao diện (`builtin`, `swagger-ui` và `scalar`).
- **Lọc đơn phiên bản & cô lập schema**: gọi `SwaggerModule.createDocument(app, config, { version: "1", includeVersionNeutral: true })` để tạo đặc tả riêng với `components.schemas` chỉ gồm các DTO mà phiên bản đó sử dụng.
- **Hỗ trợ cả 4 chiến lược**: `URI` tạo path theo phiên bản; `HEADER` và `MEDIA_TYPE` tự chèn tham số header tương ứng (`required: false` khi là `VERSION_NEUTRAL` hoặc khớp `defaultVersion`); `CUSTOM` hỗ trợ `customVersionParameter` (`query`, `header` hoặc `cookie`).

> warning **Chế độ Header, Media Type & Custom** Do các phiên bản khác nhau dùng chung path và HTTP method (ví dụ `GET /users`) ở chế độ `HEADER`, `MEDIA_TYPE` và `CUSTOM`, việc tạo một tài liệu đơn không lọc sẽ khiến phiên bản sau ghi đè phiên bản trước. Hãy dùng `SwaggerModule.createVersionedDocuments()` hoặc `createDocument(..., { version })` để tránh xung đột.

> info **Tài liệu OpenAPI đầy đủ** Xem hướng dẫn [`@bunest/swagger`](/apis/openapi) để biết chi tiết về `discoverApiVersions()`, `infoVersionResolver`, `customVersionParameter` và các preset UI.
