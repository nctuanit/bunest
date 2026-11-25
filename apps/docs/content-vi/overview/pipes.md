# Pipes

Pipe là một class triển khai interface `PipeTransform`. Pipe thực thi ở **Giai đoạn 8 (Stage 8)** của execution pipeline—ngay sau bước trích xuất tham số và trước khi gọi controller handler—nhằm phục vụ hai mục đích cốt lõi:

1. **Chuyển đổi (Transformation)** — biến đổi chuỗi đầu vào thô sang kiểu mong muốn (ví dụ `"42"` thành `42`, `"true"` thành `true`, hoặc JSON thuần thành instance của DTO class).
2. **Xác thực (Validation)** — kiểm tra dữ liệu đầu vào và ném `BadRequestException` (400) nếu không hợp lệ, ngăn không cho handler được thực thi.

> info **Không ép kiểu ngầm** Query string, path param, header và cookie luôn có kiểu `string` (hoặc `string[]`). Bunest **không bao giờ** tự ý chạy `Boolean("false") === true` hay ép kiểu số ngầm định—hãy dùng các pipe tích hợp sẵn một cách tường minh hoặc dùng `ValidationPipe` cùng `@Type()`.

## Các Parse Pipe tích hợp sẵn

Bunest đi kèm 7 pipe dựng sẵn:

| Pipe               | Mục đích                                                         | Ví dụ Đầu vào &rarr; Đầu ra                        |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------------------- |
| `ParseIntPipe`     | Parse số nguyên hệ cơ số 10 nghiêm ngặt                          | `"42"` &rarr; `42` (từ chối `"42px"`, `"3.14"`)    |
| `ParseFloatPipe`   | Parse số thực hữu hạn nghiêm ngặt                                | `"3.14"` &rarr; `3.14` (từ chối `NaN`, `Infinity`) |
| `ParseBoolPipe`    | Parse chuỗi boolean nghiêm ngặt                                  | `"true"` / `"false"` &rarr; `true` / `false`       |
| `ParseUUIDPipe`    | Kiểm tra UUID chuẩn RFC 4122 (`version?: "3"\|"4"\|"5"\|"7"\|"all"`) | `"550e8400-..."` &rarr; chuỗi đã xác thực     |
| `ParseEnumPipe`    | Kiểm tra giá trị thuộc một TS `enum` / object                    | `"ADMIN"` &rarr; `Role.ADMIN`                      |
| `ParseArrayPipe`   | Tách & parse chuỗi CSV / giá trị lặp lại                         | `"1,2,3"` &rarr; `[1, 2, 3]`                       |
| `DefaultValuePipe` | Cung cấp giá trị dự phòng khi `undefined` / `null` / `""`        | `undefined` &rarr; `1`                             |

## Gắn Pipe cho tham số

Truyền trực tiếp class pipe hoặc instance đã cấu hình vào `@Param()`, `@Query()`, `@Body()` hoặc `@Headers()`:

@@filename(items.controller.ts)

```ts
import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpStatus,
  Param,
  ParseArrayPipe,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
} from "@bunest/core";

@Controller("items")
export class ItemsController {
  @Get(":id")
  findOne(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Query("includeDeleted", new DefaultValuePipe(false), ParseBoolPipe)
    includeDeleted: boolean,
  ) {
    return { id, includeDeleted };
  }

  @Get("page/:page")
  paginate(
    @Param(
      "page",
      new ParseIntPipe({ errorHttpStatusCode: HttpStatus.NOT_ACCEPTABLE }),
    )
    page: number,
    @Query(
      "tags",
      new ParseArrayPipe({ items: String, separator: ",", optional: true }),
    )
    tags?: string[],
  ) {
    return { page, tags: tags ?? [] };
  }
}
```

## Chuỗi Pipe & Thứ tự ưu tiên

Khi nhiều pipe cùng áp dụng lên một tham số, chúng chạy tuần tự—đầu ra của pipe `i` trở thành đầu vào `value` cho pipe `i + 1`:

```text
Global (APP_PIPE / useGlobalPipes) -> Controller (@UsePipes) -> Method (@UsePipes) -> Parameter (@Param / @Query / @Body)
```

Các validation pipe ở cấp global, controller và method tự động bỏ qua các object thô của framework được inject qua `@Req()` và `@Res()`.

## Viết Custom Pipe

Triển khai `PipeTransform<T, R>` để xây dựng logic chuyển đổi hoặc xác thực của riêng bạn:

@@filename(trim.pipe.ts)

```ts
import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from "@bunest/core";

@Injectable()
export class TrimNonEmptyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, metadata: ArgumentMetadata): string {
    if (typeof value !== "string") {
      throw new BadRequestException(
        `${metadata.data ?? "value"} must be a string`,
      );
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(
        `${metadata.data ?? "value"} must not be empty`,
      );
    }
    return trimmed;
  }
}
```

Để tìm hiểu đầy đủ về validate DTO theo class (`ValidationPipe`) và adapter cho Zod/Valibot (`SchemaValidationPipe`), hãy xem tiếp [Validation](/techniques/validation).
