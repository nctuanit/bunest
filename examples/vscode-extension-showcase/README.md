# Bunest VS Code Extension & Customizable Magic Showcase (`vscode-bunest`)

Mở riêng thư mục này trong **Antigravity IDE / VS Code** (`File -> Open Folder... -> examples/vscode-extension-showcase`) để trải nghiệm toàn bộ tính năng của `bunest.vscode-bunest` và **Customizable Magic Architecture (ADR-018)**.

## Checklist test nhanh trong 2 phút

1. **Activity Bar & Status Bar**:
   - Bấm icon **Bunest** bên trái → kiểm tra đủ 4 panel: **Routes** (`/users`, `/orders`), **Data & Repositories**, **Events & RPC**, **Modules & DI**.
   - Xem góc dưới bên phải: bấm thanh trạng thái Bunest để regen `.bunest/types/bunest.d.ts` theo `bunest.config.ts`.
2. **`bunest.config.ts` & Custom Macros / Presets** (`bunest.config.ts`, `src/magic/custom-macros.ts`):
   - Mở `bunest.config.ts` → xem cấu hình `defineBunestConfig(...)` với global macro defaults, preset `@DomainEntity`, custom macro `@Auditable`, custom ORM operator `IContains`, và architecture rule `noRepositoryInControllerRule`.
   - Mở `src/magic/custom-macros.ts` → Hover vào `AuditNote` để xem đầy đủ members từ cả `@DomainEntity()` và `@Auditable()` (`auditTag`, `updatedBy`, `markUpdated()`, `auditVersion()`, `builder()`, `Fields`), hoặc bấm CodeLens **`✨ ... macro members`** để **Delombok**.
3. **Declarative Repository IntelliSense + Custom Operators / Scopes / Pagination** (`src/users/user.repository.ts`, `src/orders/order.repository.ts`):
   - **Autocomplete chuỗi**: Thêm dòng `abstract findAllBy` bên trong `OrderRepository` → gõ `OrderCode` → thấy cả operator tùy chỉnh **`IContains`** lẫn `findPageBy` / `findCursorBy`.
   - **Live SQL Hover & CodeLens**: Di chuột lên `findByOrderCode` (`@Projection`), `findPageByStatus` (`Page<T>`), `countByStatus` (`@IgnoreScope("softDelete")`), và `findAllByOrderCodeIContains` (`IContains` + `@SoftDelete()`) để xem SQL đa dialect; bấm **`Convert to @Query`** để chuyển sang `@Query(...)` bằng `TextEditor`.
   - **Cmd+Click nhảy tới Entity `@Column`**: Giữ `Cmd` + click vào tên field trong method derived query → nhảy thẳng tới cột tương ứng trong entity.
4. **Generate CrudRepository từ `@Entity()`** (`src/orders/coupon.entity.ts`):
   - Mở `src/orders/coupon.entity.ts` → bấm CodeLens **`✨ Generate CrudRepository for CouponEntity`** → tự tạo file `coupon.repository.ts` có sẵn finder theo `@Unique()` / `@Index()`.
5. **Bunest Built-in Class Macros** (`src/users/user.entity.ts`, `src/users/money.vo.ts`):
   - Hover lên `@Data()` / `@Builder()` trên `UserEntity` hoặc `@Value()` + `@WithBy()` trên `Money` → xem bảng generated members và thử **`Expand (Delombok)`**.
6. **Service-Layer AOP Pipeline & Conditional Beans** (`src/magic/aop-pipeline.ts`, `src/magic/conditional-cache.ts`):
   - Xem `@AuditedOperation()` (`defineAspectPipeline` + `AspectPhase.OBSERVABILITY` / `AspectPhase.AUDIT`) trên `UsersService.findAll()` và `OrdersService.listByStatus()`.
   - Xem `@RegisterIfMissing(ShowcaseCacheStore)` và `@Profile("!production")` trong `src/magic/conditional-cache.ts`.
7. **Cross-Jump & Secret Redaction** (`src/users/users.service.ts`, `src/users/users.events.ts`):
   - Hover vào `"JWT_SECRET"` trong `config.get("JWT_SECRET")` → hiển thị **`[REDACTED]`**; hover vào `"PORT"` → hiển thị **`3100`**.
   - `Cmd+Click` vào `"user.created"` → nhảy thẳng sang `@OnEvent("user.created")` trong `src/users/users.events.ts`.
   - `Cmd+Click` vào `printer` (`@Delegate()`) → nhảy tới `AuditPrinter`.
8. **Static Diagnostics + Architecture Rules + AST Quick Fixes** (`src/diagnostics-demo.ts`):
   - Mở `src/diagnostics-demo.ts` → kiểm tra gạch đỏ/vàng `BUNEST_REPO001..007`, `BUNEST_MACRO001..004`, `BUNEST004`, `BUNEST007`, và **`BUNEST_ARCH001`** (`BadArchDemoController`), nhấn **`Cmd + .`** để áp dụng Quick Fix 1-click!
9. **Inline HTTP Request Runner & Interactive DI Graph**:
   - Chạy server: `bun run dev` (cổng `3100`).
   - Mở `src/users/users.controller.ts` hoặc `src/orders/orders.controller.ts` → bấm CodeLens **`▶ Send GET /users`** / **`▶ Send GET /orders`**.
   - Nhấn `Cmd + Shift + P` → **`Bunest: Open Interactive DI Module Graph`**.
10. **Test Runner CodeLens** (`test/showcase.spec.ts`):
    - Mở `test/showcase.spec.ts` → bấm **`▶ Run bun test`** (hoặc chạy `bun test`).
