# Class, Field & Method Macros

Bunest cung cấp **27 macro zero-dependency lấy cảm hứng từ Lombok** ngay trong `@bunest/core`, giúp loại bỏ code lặp lại trên DTO, domain model, value object, exception và service — đi kèm hỗ trợ gợi ý kiểu và xem trước Delombok trong [VS Code Extension](/recipes/vscode-extension).

## Macro Model tổng hợp

### `@Data()` & `@Value()`

- `@Data()` tự động sinh getters, setters, `equals()`, `hashCode()` và `toString()`.
- `@Value()` tạo **value object bất biến** (đóng băng thuộc tính, chỉ có getter, `equals()`, `toString()`). Dùng `@NonFinal()` trên một field cụ thể nếu muốn cho phép thay đổi field đó.

@@filename(money.value.ts)

```ts
import { Secret, Value } from "@bunest/core";

@Value()
export class Money {
  amount: number;
  currency: string;
}

@Value()
export class ApiCredential {
  clientId: string;

  @Secret()
  clientSecret: string; // tự động ẩn thành "[REDACTED]" trong toString() & JSON
}
```

### `@Builder()` & `@SuperBuilder()`

Sinh API builder dạng chuỗi (`ClassName.builder()...build()`) kết hợp `@Singular()` để thêm từng phần tử vào mảng:

@@filename(invoice.model.ts)

```ts
import { Builder, Data, Singular } from "@bunest/core";

@Data()
@Builder()
export class Invoice {
  id: string;
  customerId: string;

  @Singular()
  items: string[];
}
```

## Nhân bản bất biến (`@With`, `@WithBy`)

Sinh các hàm sao chép không làm biến đổi object gốc (`withField(newValue)` / `withFieldBy(fn)`):

@@filename(user-settings.model.ts)

```ts
import { Value, With, WithBy } from "@bunest/core";

@Value()
@With()
@WithBy()
export class UserSettings {
  theme: "light" | "dark";
  retryLimit: number;
}
```

## Accessors, Field Defaults & Tiện ích

| Macro | Vị trí | Hành vi |
| --- | --- | --- |
| `@Getter()` / `@Setter()` | Class / Prop | Sinh phương thức getter và/hoặc setter có kiểu. |
| `@Accessors({ fluent?, chain?, prefix? })` | Class / Prop | Cấu hình kiểu đặt tên fluent hoặc chainable. |
| `@ToString({ exclude?, includeFieldNames? })` | Class | Sinh `toString()` nhất quán (tự động che các field gắn `@Secret()`). |
| `@EqualsAndHashCode({ exclude? })` | Class | Sinh hàm so sánh giá trị `equals(other)` và `hashCode()`. |
| `@FieldDefaults(options)` | Class | Thiết lập mặc định quyền truy cập/bất biến cho toàn bộ field trong class. |
| `@FieldNameConstants()` | Class | Tạo đối tượng tĩnh `Fields` ánh xạ tên thuộc tính thành hằng số chuỗi. |
| `@Delegate()` | Prop | Ủy quyền các method công khai của object con lên class cha. |
| `@NonNull()` | Prop / Param | Ném `TypeError` ngay lập tức nếu gán hoặc truyền `null`/`undefined`. |
| `@UtilityClass()` | Class | Ngăn khởi tạo bằng `new` đối với các class chỉ chứa hàm tiện ích tĩnh. |
| `@StandardException()` | Class | Sinh constructor `(message?, cause?)` chuẩn cho lớp `Error` tùy chỉnh. |
| `@JsonSerializable()` | Class | Sinh `toJSON()` tôn trọng `@Secret()` và tùy chọn serialize. |

## Method Aspect Macros

| Macro | Công dụng |
| --- | --- |
| `@Memoize({ ttlMs?, maxSize?, key? })` | Cache kết quả trả về trong bộ nhớ theo tham số đầu vào. |
| `@LogExecution({ level?, slowThresholdMs? })` | Tự động ghi log thời gian thực thi và lỗi của method. |
| `@WithLogger(context?)` | Tự động gắn một `Logger` theo ngữ cảnh vào instance (`this.logger`). |
| `@Synchronized(lockName?)` | Tuần tự hóa các cuộc gọi async đồng thời trên cùng instance bằng mutex nội bộ. |
| `@Locked(lockName?)` | Khóa độc quyền theo tên xung quanh phần thân method. |

@@filename(exchange-rate.service.ts)

```ts
import {
  Injectable,
  LogExecution,
  Memoize,
  Synchronized,
  WithLogger,
} from "@bunest/core";

@Injectable()
@WithLogger("ExchangeRateService")
export class ExchangeRateService {
  @Memoize({ ttlMs: 60_000 })
  @LogExecution({ slowThresholdMs: 250 })
  async getRate(pair: string): Promise<number> {
    const res = await fetch(`https://rates.example.com/${pair}`);
    const data = (await res.json()) as { rate: number };
    return data.rate;
  }

  @Synchronized()
  async syncAllRates(): Promise<void> {
    // Đảm bảo không chạy chồng chéo trên cùng một instance
  }
}
```

> tip **Live Typegen không cần lưu file** Cài đặt [Bunest VS Code Extension](/recipes/vscode-extension) để nhận autocomplete, hover signature và xem trước **Delombok** cho mọi method do macro sinh ra.
