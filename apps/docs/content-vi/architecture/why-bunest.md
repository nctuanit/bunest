# Vì sao chọn Bunest? Giải quyết 10 nỗi đau lớn nhất của cộng đồng NestJS

NestJS đã đặt chuẩn mực cho kiến trúc backend TypeScript có tổ chức (`@Module`, `@Controller`, DI, Guards, Pipes, Interceptors, Exception Filters, `TestingModule`). Tuy nhiên, sau nhiều năm vận hành thực tế trên Node.js, cộng đồng lập trình viên liên tục phản ánh 10 điểm nghẽn lặp đi lặp lại.

Bunest giữ nguyên mô hình tư duy của NestJS (đạt 100% NestJS v12 core conformance) nhưng giải quyết triệt để cả 10 nỗi đau này ngay từ nền tảng **Bun >= 1.4.5**.

## Bảng đối chiếu 10 nỗi đau & Giải pháp của Bunest

| # | Nỗi đau cộng đồng NestJS | Cách Bunest giải quyết |
| --- | --- | --- |
| 1 | Quá nhiều boilerplate cho API nhỏ / serverless | `defineRoutes()`, `BunestFactory.createRoutes()`, `BunestFactory.createAuto({ routes })`, `createFetchHandler()` |
| 2 | Lỗi DI chỉ phát hiện lúc runtime | Báo lỗi sớm với mã `BUNEST_E*` kèm các bước sửa, phân tích tĩnh `bunest check`, chặn rò rỉ scope lúc khởi động |
| 3 | Cold start chậm & `node_modules` phình to | **0 phụ thuộc runtime ngoài** trên cả 19 gói (`ADR-017`), khởi động `~0.11 ms`, `Bun.serve` gốc |
| 4 | Bắt buộc dùng RxJS trong Interceptors, SSE & Microservices | Interceptor dùng `Promise<T>` thuần (`async/await`), SSE dùng `AsyncGenerator` — không có RxJS |
| 5 | `Scope.REQUEST` lan truyền âm thầm làm tụt hiệu năng | Báo lỗi ngay `ScopeLeakException` (`BUNEST_E003`) + `ClsModule` (`AsyncLocalStorage`) giữ singleton ở tốc độ tối đa |
| 6 | Lặp lại DTO, decorator Swagger và type phía frontend | Một nguồn chân lý duy nhất `defineContract()` &rarr; `implementContract()` + tự động OpenAPI 3.1 + `createContractClient()` |
| 7 | Viết test E2E rườm rà và mở TCP socket qua Supertest | Test nội bộ không mở socket với `request(app)`, `app.fetch()`, và `mod.createContractClient(contract)` có type đầy đủ |
| 8 | Decorator metadata bị hỏng khi bundle hoặc biên dịch binary | `bunest build` & `bunest build --compile` mặc định bật AOT DI metadata (`aotDiMetadata: true`) |
| 9 | Ghép nối Passport.js rườm rà cho auth/authz thực tế | `@bunest/security/auth` (JWT + refresh rotation + TOTP MFA + API key) & `@bunest/security/authz` (`@Policy` / `@Can`) gốc |
| 10 | Microservices, resilience & storage phải lắp ghép nhiều thư viện rời | Tích hợp sẵn `@bunest/microservices` (CLS + DLQ), `@bunest/resilience` (`@Retry`, `@CircuitBreaker`, `@Idempotent`), `@bunest/storage` |

---

## 1. Tối giản khi khởi đầu, đầy đủ DI khi mở rộng

Với microservice nhỏ hoặc edge handler, bạn không cần tạo hàng loạt `@Module` và `@Controller`. Hãy bắt đầu bằng functional routes và vẫn tận dụng trọn vẹn DI của Bunest:

```ts
import { BunestFactory, Injectable, defineRoutes } from "@bunest/core";
import { s } from "@bunest/validation/schema";

@Injectable()
class GreetingService {
  greet(name: string) {
    return `Xin chào, ${name}!`;
  }
}

const routes = defineRoutes("/api", { tags: ["Greeting"] })
  .get("/hello/:name", {
    params: s.object({ name: s.string().min(1) }),
    responseSchema: s.object({ message: s.string() }),
    handler: ({ params }, app) => ({
      message: app.get(GreetingService).greet(params.name),
    }),
  });

const app = await BunestFactory.createRoutes(routes, {
  providers: [GreetingService],
});
await app.listen(3000);
```

Xem thêm hướng dẫn [Functional Routes & Single Binary](/vi/recipes/functional-routes) và ví dụ [`examples/functional-minimal`](https://github.com/nctuanit/bunest/tree/main/examples/functional-minimal).

## 2. Chẩn đoán DI sớm & mã lỗi `BUNEST_E*` rõ ràng

Thay vì sập ngầm lúc nhận request vì dependency bị `undefined`, Bunest kiểm tra toàn bộ đồ thị DI, phụ thuộc vòng và ranh giới scope ngay trong `app.init()`. Mọi lỗi đều đi kèm mã ổn định (`BUNEST_E001`–`BUNEST_E205`), đường dẫn resolve và hướng dẫn sửa cụ thể. Bạn cũng có thể chạy `bunest check` trong CI để bắt lỗi ngay từ bước phân tích tĩnh.

## 3. Không phụ thuộc runtime ngoài & biên dịch một file thực thi

Tất cả 19 gói `@bunest/*` đều có **0 phụ thuộc runtime ngoài** (`ADR-017`), chạy trực tiếp trên `Bun.serve`, `Bun.SQL`, `bun:sqlite`, `Bun.RedisClient`, `Bun.password`, `Bun.CryptoHasher` và WebCrypto. Kết hợp với `bunest build --compile` (tự động chèn AOT DI metadata), bạn có thể đóng gói toàn bộ backend thành một file binary duy nhất có thời gian khởi động tức thì.

## 4. `Promise<T>` & `AsyncGenerator` thuần (Không dùng RxJS)

Interceptor chỉ cần `async/await` tự nhiên:

```ts
@Injectable()
export class TimingInterceptor implements BunestInterceptor {
  async intercept(ctx: ExecutionContext, next: CallHandler) {
    const start = performance.now();
    const result = await next.handle();
    console.log(`${(performance.now() - start).toFixed(2)} ms`);
    return result;
  }
}
```

Tương tự, `@Sse()` sử dụng trực tiếp `async *` generator kết hợp `@SseSignal()` thay vì phải bọc `Observable`.

## 5. Chấm dứt bẫy hiệu năng `Scope.REQUEST`

Trong NestJS, chỉ một provider con mang `Scope.REQUEST` có thể âm thầm biến toàn bộ chuỗi service và controller phía trên thành request-scoped. Bunest chặn đứng việc lan truyền ngầm bằng `ScopeLeakException` lúc khởi động và khuyến nghị dùng `ClsModule` (`ClsService`) để giữ ngữ cảnh theo request trong khi vẫn duy trì singleton siêu nhanh (>5 triệu ops/s).

## 6. Một Contract duy nhất: Server + Tự động OpenAPI 3.1 + Typed Client

Định nghĩa API đúng một lần bằng `defineContract()` cùng Standard Schema (`s.*`, Zod, Valibot hoặc ArkType). Bunest tự động dùng nguồn định nghĩa đó cho cả 3 lớp:

1. **Định tuyến, validate đầu vào và chuẩn hóa đầu ra phía server** qua `implementContract()` / `FunctionalModule.forContract()`
2. **Tài liệu OpenAPI 3.1 & Swagger UI** qua `@bunest/swagger` (không cần lặp lại `@ApiProperty()` / `@ApiResponse()`)
3. **Client chạy thực tế & test client có type end-to-end** qua `createContractClient()` và `mod.createContractClient()`

Xem hướng dẫn [Contracts & Typed RPC Client](/vi/apis/contracts-typed-client) và ví dụ [`examples/fullstack-contract-rpc`](https://github.com/nctuanit/bunest/tree/main/examples/fullstack-contract-rpc).

## 7. Kiểm thử E2E không mở socket và an toàn kiểu dữ liệu

Không còn cảnh tranh chấp port hay phụ thuộc Supertest. Test cả controller truyền thống lẫn API theo contract ngay trong bộ nhớ bằng `app.fetch()`, `request(app)` hoặc `mod.createContractClient(contract)`:

```ts
const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
const client = await mod.createContractClient(tasksContract);

const created = await client.tasks.create({ body: { title: "Ship v1" } });
expect(created.title).toBe("Ship v1");
```

## 8. Đóng gói & biên dịch binary không lo mất DI Metadata

`emitDecoratorMetadata` thường hỏng khi qua bundler nếu thiếu plugin cấu hình. `bunest build` và `bunest build --compile` tự động bật `createBunestPlugin({ aotDiMetadata: true })`, tạo metadata DI tĩnh ngay khi build.

## 9. Xác thực & Phân quyền ABAC gốc (Không cần Passport)

`@bunest/security/auth` và `@bunest/security/authz` thay thế hoàn toàn hệ sinh thái Passport cồng kềnh bằng các công cụ thuần Bun: băm mật khẩu Argon2id (`PasswordHasher`), JWT + refresh token xoay vòng kèm phát hiện tái sử dụng & thu hồi toàn bộ token family, TOTP MFA mã hóa AES-GCM (`MfaService`), `ApiKeyProvider` có prefix, và phân quyền ABAC mặc định từ chối với `@Policy()` / `@Can()`.

Xem ví dụ [`examples/multi-auth-security`](https://github.com/nctuanit/bunest/tree/main/examples/multi-auth-security).

## 10. Hệ thống phân tán & Lưu trữ tệp sẵn sàng cho Production

- **Microservices chống lỗi**: `@bunest/microservices` tự động truyền ngữ cảnh `ClsService` và W3C `traceparent` qua RPC, kèm `deadLetterHandler` (DLQ) cho poison message.
- **Resilience & Idempotency**: `@bunest/resilience` tích hợp `@Retry`, `@CircuitBreaker`, `@Fallback`, `@Timeout`, `@Bulkhead`, khóa phân tán `@WithLock` và chống trùng lặp request `@Idempotent()`.
- **Lưu trữ đối tượng & Signed URL**: `@bunest/storage` cung cấp `InMemoryDisk`, `LocalDisk` và `S3Disk` (AWS S3 / R2 / MinIO) với presigned upload/download, HTTP Range `206`, ETag `304` và `inspectImage()`.

Xem ví dụ [`examples/broker-microservices`](https://github.com/nctuanit/bunest/tree/main/examples/broker-microservices) và [`examples/storage-signed-uploads`](https://github.com/nctuanit/bunest/tree/main/examples/storage-signed-uploads).
