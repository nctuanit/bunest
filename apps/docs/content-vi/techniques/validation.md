# Validation

`@bunest/validation` cung cấp khả năng kiểm tra dữ liệu DTO bền bỉ cho môi trường production mà không phụ thuộc thư viện ngoài, được vận hành mặc định bởi bộ validator (`@bunest/validation/validator`) và transformer (`@bunest/validation/transformer`) biên dịch một lần gốc của Bunest (`ValidationPipe`, [ADR-015](/architecture/adrs) & [ADR-009](/architecture/adrs)), đồng thời hỗ trợ song song mượt mà cả hai engine cho các DTO `class-validator`/`class-transformer` có sẵn, cộng thêm các adapter hạng nhất **`StandardSchemaValidationPipe`** / **`SchemaValidationPipe`** cho **Zod, Valibot, TypeBox**, hoặc các schema validator tùy chỉnh!

## Kích hoạt `ValidationPipe`

Gắn `ValidationPipe` ở phạm vi toàn cục, trên một controller/method (`@UsePipes`), hoặc trên một tham số đơn lẻ (`@Body(new ValidationPipe())`):

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe());
await app.listen(3000);
```

> info **Thực thi theo lựa chọn (Opt-In Execution — ADR-005 / ADR-015)** Các validation decorator (`@IsEmail()`, `@MinLength()`) chỉ đăng ký metadata — chúng **không** kiểm tra request đầu vào trừ khi có `ValidationPipe` được gắn vào. Các endpoint không có DTO hoặc không dùng `ValidationPipe` sẽ không tốn bất kỳ chi phí validation nào.

## Viết các DTO có kiểm tra hợp lệ

Dùng các ràng buộc từ `@bunest/validation/validator` và `@Type()` tường minh từ `@bunest/validation/transformer` cho DTO lồng nhau, mảng, và chuyển đổi kiểu số tường minh (các DTO `class-validator` / `class-transformer` có sẵn cũng tự động tiếp tục hoạt động bình thường):

@@filename(create-order.dto.ts)

```ts
import { Type } from "@bunest/validation/transformer";
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from "@bunest/validation/validator";

export class OrderItemDto {
  @IsString()
  sku!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CreateOrderDto {
  @IsEmail()
  customerEmail!: string;

  @IsString()
  @MinLength(2)
  customerName!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @IsOptional()
  @IsString()
  promoCode?: string;
}
```

## `ValidationPipeOptions` an toàn theo mặc định (ADR-009)

Khác với các thiết lập mặc định lỏng lẻo dễ gây lỗi mass-assignment hoặc ép kiểu ngầm, `new ValidationPipe()` của Bunest đi kèm các tùy chọn mặc định nghiêm ngặt, ưu tiên bảo mật hàng đầu:

| Tùy chọn                                    | Mặc định | Lý do                                                                                  |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `whitelist`                                 | `true`   | Loại bỏ các thuộc tính không có decorator (chống lỗ hổng mass assignment)              |
| `forbidNonWhitelisted`                      | `true`   | Từ chối các trường không mong muốn bằng HTTP 400 thay vì âm thầm bỏ qua chúng          |
| `forbidUnknownValues`                       | `true`   | Ngăn payload không phải object hoặc thiếu decorator lọt qua như một DTO rỗng hợp lệ    |
| `transform`                                 | `true`   | Chuyển đổi JSON thuần thành instance DTO thực thụ qua `plainToInstance()`              |
| `transformOptions.enableImplicitConversion` | `false`  | **Chính sách chuyển đổi tường minh** — không bao giờ biến `"false"` thành `true`       |
| `validationError.target`                    | `false`  | Ẩn toàn bộ DTO khỏi thông báo lỗi (không bao giờ lặp lại mật khẩu/bí mật)              |
| `validationError.value`                     | `false`  | Ẩn giá trị đầu vào bị từ chối khỏi thông báo lỗi (không bao giờ lặp lại dữ liệu PII)  |
| `stopAtFirstError`                          | `false`  | Trả về tất cả các vi phạm trường dữ liệu trong một response duy nhất                   |
| `errorHttpStatusCode`                       | `400`    | Ném `BadRequestException` (có thể ghi đè, ví dụ `422`)                                 |

> warning **Chống Prototype Pollution** Trước khi chạy `plainToInstance()`, cả `ValidationPipe` và `SchemaValidationPipe` đều quét payload để tìm các khóa nguy hiểm (`__proto__`, `constructor`, `prototype`) bằng `findDangerousKeys()` và từ chối ngay với mã HTTP 400!

## Định dạng lỗi HTTP 400 chuẩn hóa

Các đối tượng lồng nhau và phần tử mảng tự động được làm phẳng thành đường dẫn trường dạng dấu chấm/ngoặc vuông xác định (`address.zipCode`, `items[0].quantity`). Cây `ValidationError` thô không bao giờ bị rò rỉ trực tiếp ra ngoài:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": [
    {
      "field": "customerEmail",
      "constraints": {
        "isEmail": "customerEmail must be an email"
      },
      "messages": ["customerEmail must be an email"]
    },
    {
      "field": "items[0].quantity",
      "constraints": {
        "min": "quantity must not be less than 1"
      },
      "messages": ["quantity must not be less than 1"]
    },
    {
      "field": "isAdmin",
      "constraints": {
        "whitelistValidation": "property isAdmin should not exist"
      },
      "messages": ["property isAdmin should not exist"]
    }
  ],
  "timestamp": "2026-11-20T03:00:00.000Z",
  "path": "/orders"
}
```

## Sử dụng Zod / Valibot với `SchemaValidationPipe`

Bạn thích kiểm tra theo hướng schema trước (schema-first)? `SchemaValidationPipe` tương thích với bất kỳ `SchemaValidator<T>` nào có triển khai `parse`, `parseAsync`, `safeParse`, hoặc `safeParseAsync` — tự động chuẩn hóa các lỗi thành **chính xác cùng một định dạng HTTP 400 theo ADR-009** và thực thi bảo vệ chống prototype-pollution!

@@filename(create-user.controller.ts)
@@tab(@bunest/validation DTO)

```ts
import { Body, Controller, Post, UsePipes } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { CreateUserDto } from "./create-user.dto";

@Controller("users")
export class UsersController {
  @Post()
  @UsePipes(new ValidationPipe())
  create(@Body() dto: CreateUserDto) {
    return dto;
  }
}
```

@@switch
@@tab(Zod / SchemaValidationPipe)

```ts
import { Body, Controller, Post } from "@bunest/core";
import { SchemaValidationPipe } from "@bunest/validation";
import { z } from "zod";

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(3),
});

type CreateUserInput = z.infer<typeof createUserSchema>;

@Controller("users")
export class UsersController {
  @Post()
  create(
    @Body(new SchemaValidationPipe(createUserSchema))
    dto: CreateUserInput,
  ) {
    return dto;
  }
}
```
