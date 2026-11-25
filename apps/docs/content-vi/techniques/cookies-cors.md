# Cookies & CORS

Bunest tích hợp trực tiếp với `req.cookies` (`CookieMap`) gốc của Bun, cơ chế tuần tự hóa `Set-Cookie` tuân thủ chuẩn RFC, và xử lý CORS tích hợp sẵn tại Giai đoạn 3 của execution pipeline.

## Đọc Cookie (`@Cookies()`)

Trích xuất toàn bộ cookie dưới dạng bản đồ key-value hoặc đọc trực tiếp một cookie cụ thể thông qua `@Cookies()`:

@@filename(session.controller.ts)

```ts
import { Controller, Cookies, Get, Post, Res } from "@bunest/core";
import type { ResponseContext } from "@bunest/core";

@Controller("session")
export class SessionController {
  @Get()
  inspect(
    @Cookies("session_id") sessionId?: string,
    @Cookies() all?: Record<string, string>,
  ) {
    return {
      sessionId: sessionId ?? null,
      count: Object.keys(all ?? {}).length,
    };
  }

  @Post("login")
  login(@Res() res: ResponseContext) {
    res.cookie("session_id", "tok_9f8a7b", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
    res.cookie("theme", "dark", { path: "/" });
    return { loggedIn: true };
  }

  @Post("logout")
  logout(@Res() res: ResponseContext) {
    res.clearCookie("session_id", { path: "/" });
    return { loggedOut: true };
  }
}
```

> info **Bất biến đa Cookie (ADR-010)** Khi gọi `res.cookie(...)` nhiều lần, hệ thống luôn sử dụng `headers.append("Set-Cookie", ...)` — không bao giờ dùng `headers.set()` — nhờ đó nhiều cookie luôn được bảo toàn nguyên vẹn trên `Response` gốc trả về.

## Cấu hình CORS (`CorsOptions`)

Bật Cross-Origin Resource Sharing thông qua `app.enableCors(options)` hoặc `BunestApplicationOptions.cors`:

@@filename(main.ts)

```ts
const app = await BunestFactory.create(AppModule, {
  cors: {
    origin: ["https://app.example.com", /\.example\.com$/],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["X-Request-Id"],
    credentials: true,
    maxAge: 86400,
  },
});
```

### Các đảm bảo của CORS Pipeline (ADR-008 & ADR-011)

- **Phản hồi preflight nhanh:** Các request preflight `OPTIONS` mang theo `Origin` và `Access-Control-Request-Method` được trả lời ngay lập tức với `204 No Content` ở cả bộ điều phối route gốc theo từng đường dẫn lẫn nhánh fallback `fetch()`.
- **Bảo toàn trên các response lỗi:** Do CORS chạy bên trong ranh giới Exception Filter, các response `400`, `401`, `403`, `404`, `405`, `413`, và `500` luôn giữ lại các header `Access-Control-*` đã cấu hình để trình duyệt nhận được lỗi API rõ ràng thay vì lỗi CORS mơ hồ.

## Địa chỉ IP của Client & `trustProxy`

Đọc địa chỉ IP của client bằng `@Ip()`. Mặc định, Bunest đọc trực tiếp `server.requestIP(req)?.address` và bỏ qua các header `X-Forwarded-For` dễ bị giả mạo trừ khi `trustProxy` được bật tường minh trong `BunestApplicationOptions`.
