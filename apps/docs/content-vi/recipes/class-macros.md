# Chuyển đổi các class dùng macro cũ

Bunest đã gỡ các decorator runtime kiểu Lombok khỏi `@bunest/core` tại [commit 790eb87](https://github.com/nctuanit/bunest/commit/790eb87). Nếu ví dụ cũ import `Data`, `Value` hoặc `Builder` từ core, hãy cập nhật class trước khi nâng cấp. Các decorator của framework như `@Injectable()` vẫn dùng được.

## Các decorator đã gỡ

| Công dụng trước đây | Tên cần tìm trong các lệnh import |
| --- | --- |
| Model, getter/setter và so sánh giá trị | `Data`, `Value`, `NonFinal`, `Getter`, `Setter`, `Accessors`, `ToString`, `EqualsAndHashCode`, `FieldDefaults`, `FieldNameConstants` |
| Khởi tạo, sao chép và ủy quyền | `Builder`, `SuperBuilder`, `Singular`, `With`, `WithBy`, `Delegate`, `NonNull`, `UtilityClass`, `StandardException` |
| Tuần tự hóa, ghi log, cache và khóa | `Secret`, `JsonSerializable`, `WithLogger`, `Memoize`, `LogExecution`, `Synchronized`, `Locked` |

## Cách cập nhật một class

1. Tìm những chỗ đang gọi thành phần được macro sinh ra, chẳng hạn `Order.builder()`, `withQuantity()` hoặc `equals()`. Viết lại các thành phần mà code còn dùng trước khi xóa decorator. Nếu class từng dùng `@Value()` và ứng dụng cần ngăn sửa dữ liệu lúc chạy, hãy test hành vi đó. TypeScript chỉ kiểm tra `readonly` lúc biên dịch.
2. Với field từng gắn `@Secret()`, chọn rõ những field mà DTO trả về và logger được phép ghi. Dùng giá trị bí mật giả trong test, rồi kiểm tra cả JSON lẫn log sau khi chuyển đổi.
3. Với method của service, viết test cho hành vi ứng dụng cần giữ. Ví dụ, kiểm tra khi nào cache hết hạn hoặc những lời gọi đồng thời nào phải chạy tuần tự. Sau đó chuyển hành vi này sang service phù hợp hoặc viết trực tiếp trong method.

Bộ phân tích của CLI và tooling VS Code vẫn nhận diện một số tên macro cũ trong mã nguồn. Gợi ý của editor hoặc bản xem trước Delombok không có nghĩa là core còn export decorator đó. Chạy `bun check` và test hành vi của class sau khi cập nhật.
