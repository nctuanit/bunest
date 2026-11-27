# VS Code Extension

**Bunest IDE Extension** chính thức (`apps/vscode-bunest`) mang trải nghiệm phát triển tương đương Spring Tools lên **VS Code**, **Cursor** và **Antigravity IDE**.

## Cài đặt

Tải bản `.vsix` mới nhất từ GitHub Releases và cài đặt qua CLI:

```bash
code --install-extension vscode-bunest-<version>.vsix
```

Hoặc tự build và đóng gói từ monorepo:

```bash
bun run --cwd apps/vscode-bunest package
```

## Các tính năng chính

### 1. Typegen trực tiếp cho repository

Khi bạn khai báo finder trong repository, extension cập nhật gợi ý kiểu ngay trong editor.

### 2. Autocomplete & Xem trước SQL cho Declarative Repository

Bên trong mọi class `@Repository(Entity)` kế thừa `CrudRepository<Entity, ID>`:

- **Gợi ý tên method**: Tự động gợi ý các từ khóa derived finder kiểu Spring Data (`findBy`, `findAllBy`, `countBy`, `existsBy`, `deleteBy`, `And`, `Or`, `OrderBy`, `Asc`, `Desc`, `Containing`, `Between`, `IsNull`, ...).
- **Xem trước SQL trực tiếp**: Di chuột lên tên method để xem câu lệnh SQL đã parameterize chính xác mà `@bunest/orm` sẽ biên dịch lúc khởi động.

### 3. Giải thích Route (Route Explain) & Quick Fixes

- Chạy **Bunest: Explain Route** (hoặc nhấn CodeLens ngay phía trên handler) để xem module sở hữu, pipeline thực thi, đồ thị DI và các gợi ý sửa lỗi nhanh.
- Với mã cũ cần chuyển đổi khỏi các decorator kiểu Lombok đã gỡ bỏ, xem [hướng dẫn chuyển đổi](/recipes/class-macros).

### 4. Chẩn đoán tĩnh (`BUNEST*`)

Phát hiện lỗi phổ biến ngay trong trình soạn thảo trước cả khi chạy `bun test`:

- Vô tình dùng `import type` cho DI class, DTO hoặc ORM entity (làm hỏng `emitDecoratorMetadata`).
- Thiếu `@Injectable()` hoặc quên đăng ký provider trong `@Module()`.
- Tên thuộc tính không tồn tại trong derived finder của `@Repository()`.

### 5. Đồ thị DI tương tác & HTTP Studio

- **DI & Module Graph**: Mở **Bunest: Show Dependency Graph** để quan sát trực quan quan hệ `imports`, `exports`, providers và scopes.
- **HTTP Studio & Save as Test**: Nhấn CodeLens **Run Request** ngay phía trên các handler `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete` để gửi request thử nghiệm tới dev server, xem phản hồi JSON trực tiếp và lưu thành bài test hồi quy đã lọc dữ liệu nhạy cảm.
