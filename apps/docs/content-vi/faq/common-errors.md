# Lỗi thường gặp & Danh mục `BUNEST_E*`

Mọi lỗi khởi động (bootstrap), DI và định tuyến do `@bunest/core` ném ra đều mang **mã lỗi ổn định** (`err.code`, ví dụ `BUNEST_E001`) kèm danh sách cách sửa theo thứ tự ưu tiên. Bạn cũng có thể định dạng lỗi bằng `toBunestErrorReport(err)` (JSON) hoặc `formatBunestErrorForAgent(err)` (text ngắn gọn).

## Bảng tra cứu mã lỗi

| Mã lỗi | Lớp ngoại lệ | Tóm tắt |
| --- | --- | --- |
| [`BUNEST_E001`](#bunest_e001-unknown-dependency) | `UnknownDependencyException` | DI container không thể resolve dependency trong constructor hoặc property |
| [`BUNEST_E002`](#bunest_e002-circular-dependency) | `CircularDependencyException` | Hai hay nhiều provider/module phụ thuộc vòng lẫn nhau |
| [`BUNEST_E003`](#bunest_e003-scope-leak) | `ScopeLeakException` | Provider sống lâu hơn (`SINGLETON`) phụ thuộc vào provider `REQUEST`-scoped |
| [`BUNEST_E004`](#bunest_e004-ambiguous-provider) | `AmbiguousProviderException` | Cùng một token được export bởi nhiều module khác nhau |
| [`BUNEST_E005`](#bunest_e005-invalid-module) | `InvalidModuleException` | Phần tử trong `imports` không có `@Module()` hoặc không phải `DynamicModule` hợp lệ |
| [`BUNEST_E006`](#bunest_e006-duplicate-provider) | `DuplicateProviderException` | Cùng một provider token bị khai báo lặp lại trong cùng một module |
| [`BUNEST_E007`](#bunest_e007-invalid-export) | `InvalidExportException` | Module export một token mà nó không cung cấp và cũng không import |
| [`BUNEST_E101`](#bunest_e101-duplicate-route) | `DuplicateRouteException` | Hai handler trùng HTTP method + đường dẫn chuẩn (+ host/version) |
| [`BUNEST_E102`](#bunest_e102-invalid-controller) | `InvalidControllerException` | Class nằm trong `controllers` nhưng thiếu `@Controller()` |
| [`BUNEST_E103`](#bunest_e103-invalid-route) | `InvalidRouteException` | Metadata route hoặc parameter decorator không hợp lệ / xung đột |

---

## `BUNEST_E001` — Unknown Dependency

**`UnknownDependencyException`**: DI container không tìm thấy dependency cho tham số constructor hoặc thuộc tính.

**Cách khắc phục (theo thứ tự):**
1. Thêm class còn thiếu vào mảng `providers` của module hiện tại.
2. Nếu thuộc module khác, thêm vào `exports` của module đó và import module đó vào `imports`.
3. Nếu kiểu tham số là `interface`, `union` hoặc generic (bị xóa lúc runtime), dùng `@Inject(TOKEN)` và đăng ký `{ provide: TOKEN, useClass | useValue | useFactory }`.
4. Đảm bảo dùng **value-import** (không dùng `import type`) để `design:paramtypes` giữ lại tham chiếu runtime.
5. Nếu dependency thực sự là tùy chọn, gắn `@Optional()`.

@@filename(orders.module.ts)

```ts
@Module({
  imports: [UsersModule], // UsersModule phải export UsersService
  providers: [OrdersService],
})
export class OrdersModule {}
```

## `BUNEST_E002` — Circular Dependency

**`CircularDependencyException`**: Hai hay nhiều provider (hoặc module) tạo thành vòng phụ thuộc.

**Cách khắc phục:**
1. Tách phần logic dùng chung sang một provider thứ ba *(khuyến nghị)*.
2. Với provider: dùng `@Inject(forwardRef(() => OtherService))` ở một phía.
3. Với module: dùng `forwardRef(() => OtherModule)` trong mảng `imports`.

Xem thêm tại [Phụ thuộc vòng](/fundamentals/circular-dependency).

## `BUNEST_E003` — Scope Leak

**`ScopeLeakException`**: Provider `SINGLETON` phụ thuộc vào provider `REQUEST`-scoped, có nguy cơ rò rỉ dữ liệu giữa các request.

**Cách khắc phục:**
1. Chuyển toàn bộ chuỗi phụ thuộc sang `@Injectable({ scope: Scope.REQUEST })`.
2. Hoặc giữ service là singleton và đọc dữ liệu theo request thông qua `ClsService` / `RequestContext` trong method.

Xem thêm tại [Phạm vi DI](/fundamentals/injection-scopes).

## `BUNEST_E004` — Ambiguous Provider

**`AmbiguousProviderException`**: Cùng một token được export từ nhiều module được import hoặc global.

**Cách khắc phục:**
1. Dùng token phân biệt (`Symbol("PRIMARY_DB")`, `Symbol("REPORTING_DB")`).
2. Ghi đè cục bộ trong `providers` của module sử dụng.
3. Gỡ bỏ export trùng lặp ở một trong các module.

## `BUNEST_E005` — Invalid Module

**`InvalidModuleException`**: Giá trị trong `imports` (hoặc root module) không gắn `@Module()` và không phải `DynamicModule` hợp lệ.

**Cách khắc phục:**
1. Gắn `@Module({ ... })` lên class.
2. Với dynamic module, đảm bảo `forRoot()`/`register()` trả về `{ module: MyModule, providers, exports }`.
3. Kiểm tra trường hợp import vòng ESM gây ra giá trị `undefined` và bọc bằng `forwardRef(() => OtherModule)`.

## `BUNEST_E006` — Duplicate Provider

**`DuplicateProviderException`**: Cùng một token xuất hiện nhiều hơn một lần trong mảng `providers` của một module.

**Cách khắc phục:**
1. Xóa bản ghi trùng lặp khỏi `providers`.
2. Nếu cần nhiều bản cài đặt khác nhau, gán cho chúng các token riêng biệt.

## `BUNEST_E007` — Invalid Export

**`InvalidExportException`**: Module export một token không nằm trong `providers` và cũng không được import.

**Cách khắc phục:**
1. Thêm token vào `providers` trước khi export.
2. Hoặc import module cung cấp token đó rồi re-export module đó.

## `BUNEST_E101` — Duplicate Route

**`DuplicateRouteException`**: Hai handler ánh xạ tới cùng HTTP method + đường dẫn chuẩn (kể cả khi đổi tên param như `/users/:id` và `/users/:userId`).

**Cách khắc phục:**
1. Đổi đường dẫn hoặc prefix controller của một trong hai handler.
2. Phân tách có chủ đích bằng `@Version()` ([Quản lý phiên bản API](/recipes/versioning)) hoặc `@Controller({ host })`.
3. Nếu cố ý ghi đè route, cấu hình `routeConflictPolicy` khi tạo ứng dụng.

## `BUNEST_E102` — Invalid Controller

**`InvalidControllerException`**: Class trong mảng `controllers` bị thiếu `@Controller()`.

**Cách khắc phục:**
1. Gắn `@Controller("prefix")` lên class.
2. Nếu đây là service, hãy chuyển từ `controllers` sang `providers`.

## `BUNEST_E103` — Invalid Route

**`InvalidRouteException`**: Metadata route hoặc parameter decorator bị sai cú pháp hoặc xung đột nhau trên cùng một tham số.

**Cách khắc phục:**
1. Đọc chi tiết thông báo lỗi để xác định đúng class, method và vị trí tham số.
2. Đảm bảo mỗi tham số handler chỉ gắn tối đa một decorator trích xuất (`@Body`, `@Param`, `@Query`, ...).

---

## Trace lỗi Runtime cho AI Agent (`enableDevDiagnostics`)

Trong môi trường development hoặc test, bật tính năng trace lỗi runtime có cấu trúc và các endpoint chẩn đoán ngay trên `BunestApplication` (tự động tắt khi `NODE_ENV=production`):

@@filename(main.ts)

```ts
const app = await BunestFactory.create(AppModule);
app.enableDevDiagnostics({
  filePath: ".bunest/errors.jsonl", // Tùy chọn lưu JSONL để agent/MCP đọc trực tiếp
});
await app.listen(3000);
```

Khi bật:
- Mọi response lỗi tự động được gắn header `X-Request-Id` (`req_...`) và ghi nhận chính xác giai đoạn lỗi `stage` (`routing`, `security`, `middleware`, `guard`, `interceptor`, `pipe`, `handler`, `serialization`), `controller.handler`, danh sách `appFrames` đã lọc chỉ giữ code của bạn, chi tiết validation và `fixes`.
- Mở 3 endpoint dev-only:
  - `GET /__bunest/errors?limit=20&format=agent` (hoặc `?id=req_...`)
  - `GET /__bunest/routes` — bảng route đã biên dịch
  - `GET /__bunest/graph` — đồ thị DI (modules, controllers, providers, scopes)
- Kết hợp với [`bunest mcp`](/observability/cli) để AI agent gọi trực tiếp `bunest_recent_errors` và `bunest_inspect_diagnostics`.
