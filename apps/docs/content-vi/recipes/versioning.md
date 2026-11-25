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

> info **Tích hợp OpenAPI** Khi dùng [`@bunest/swagger`](/apis/openapi), các route theo phiên bản sẽ tự động được phản ánh chính xác trong tài liệu OpenAPI 3.1.
