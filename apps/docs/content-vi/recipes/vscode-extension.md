# VS Code Extension

**Bunest IDE Extension** chính thức (`apps/vscode-bunest`) mang trải nghiệm phát triển tương đương Spring Tools và Lombok lên **VS Code**, **Cursor** và **Antigravity IDE**.

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

### 1. Live Zero-Save Typegen cho Macros & Repositories

Ngay khi bạn gõ `@Data()`, `@Builder()`, `@With()` hay khai báo derived finder trong `@Repository()`, extension tự động sinh các định nghĩa `.d.ts` theo thời gian thực — giúp TypeScript gợi ý code và kiểm tra kiểu **ngay lập tức mà không cần lưu file hay chạy build**.

### 2. Autocomplete & Xem trước SQL cho Declarative Repository

Bên trong mọi class `@Repository(Entity)` kế thừa `CrudRepository<Entity, ID>`:

- **Gợi ý tên method**: Tự động gợi ý các từ khóa derived finder kiểu Spring Data (`findBy`, `findAllBy`, `countBy`, `existsBy`, `deleteBy`, `And`, `Or`, `OrderBy`, `Asc`, `Desc`, `Containing`, `Between`, `IsNull`, ...).
- **Xem trước SQL trực tiếp**: Di chuột lên tên method để xem câu lệnh SQL đã parameterize chính xác mà `@bunest/orm` sẽ biên dịch lúc khởi động.

### 3. Hover & Xem trước Delombok cho Class Macros

- Di chuột lên `@Data()`, `@Value()`, `@Builder()`, `@Getter()`, `@Setter()` hoặc `@With()` để xem toàn bộ chữ ký hàm được sinh ra.
- Chạy lệnh **Bunest: Preview Delombok** trong Command Palette để xem code TypeScript tương đương sau khi bung macro.

### 4. Chẩn đoán tĩnh (`BUNEST*`)

Phát hiện lỗi phổ biến ngay trong trình soạn thảo trước cả khi chạy `bun test`:

- Vô tình dùng `import type` cho DI class, DTO hoặc ORM entity (làm hỏng `emitDecoratorMetadata`).
- Thiếu `@Injectable()` hoặc quên đăng ký provider trong `@Module()`.
- Kết hợp class macro xung đột nhau (ví dụ `@Value()` đi cùng `@Setter()`).
- Tên thuộc tính không tồn tại trong derived finder của `@Repository()`.

### 5. Đồ thị DI tương tác & Inline HTTP Runner

- **DI & Module Graph**: Mở **Bunest: Show Dependency Graph** để quan sát trực quan quan hệ `imports`, `exports`, providers và scopes.
- **Inline HTTP Runner**: Nhấn CodeLens **Run Request** ngay phía trên các handler `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete` để gửi request thử nghiệm tới dev server và xem phản hồi JSON ngay trong editor.
