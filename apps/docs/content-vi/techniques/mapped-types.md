# Mapped Types

Bunest cung cấp khả năng tương thích với `@nestjs/mapped-types` v12 tích hợp sẵn trong **`@bunest/validation`** và **`@bunest/core`** để dẫn xuất các class DTO từ những DTO hiện có, đồng thời bảo toàn metadata của `@bunest/validation` (cũng như `class-validator`/`class-transformer` từ upstream) và OpenAPI.

## Cài đặt

```bash
bun add @bunest/validation
```

## Các helper khả dụng

| Helper                      | Mô tả                                                                            |
| --------------------------- | -------------------------------------------------------------------------------- |
| `PartialType(BaseDto)`      | Chuyển tất cả thuộc tính thành tùy chọn và áp dụng metadata xác thực `@IsOptional()` |
| `PickType(BaseDto, keys)`   | Chọn một tập con các thuộc tính cùng metadata xác thực/biến đổi của chúng        |
| `OmitType(BaseDto, keys)`   | Loại bỏ các thuộc tính được chỉ định trong khi giữ nguyên toàn bộ metadata còn lại |
| `IntersectionType(...Dtos)` | Kết hợp hai hoặc nhiều class DTO thành một class duy nhất (variadic)             |
| `CompositionType(...Dtos)`  | Kết hợp nhiều class DTO với đầy đủ tính kế thừa metadata                         |

## Cách sử dụng

@@filename(user.dto.ts)

```ts
import { IsEmail, IsString, MinLength } from "@bunest/validation/validator";
import {
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
} from "@bunest/validation";

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  name: string;
}

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ["password"] as const),
) {}

export class LoginDto extends PickType(CreateUserDto, [
  "email",
  "password",
] as const) {}

export class AuditMetaDto {
  @IsString()
  reason: string;
}

export class AuditedUpdateUserDto extends IntersectionType(
  UpdateUserDto,
  AuditMetaDto,
) {}
```

> info **Tích hợp Swagger** `@bunest/swagger` tự động nội suy các class được tạo bằng `PartialType`, `PickType`, `OmitType` và `IntersectionType` khi sinh schema OpenAPI 3.1.
