# Serialization

Quá trình tuần tự hóa (Serialization) chuyển đổi các class instance trả về từ route handler thành các plain JSON object sạch sẽ — loại bỏ các trường nhạy cảm như `passwordHash`, hiển thị các getter được tính toán, và định hình đầu ra theo vai trò/nhóm — thông qua **`ClassSerializerInterceptor`** và **`@SerializeOptions()`** từ `@bunest/validation`.

## Loại trừ & Hiển thị thuộc tính

Gắn các decorator từ `@bunest/validation/transformer` lên entity phản hồi của bạn (`@Exclude()`, `@Expose()`, `@Transform()` — cũng tương thích với `class-transformer`):

@@filename(user.entity.ts)

```ts
import { Exclude, Expose } from "@bunest/validation/transformer";

export class UserEntity {
  id: string;
  firstName: string;
  lastName: string;
  email: string;

  @Exclude()
  passwordHash: string;

  @Expose({ groups: ["admin"] })
  internalNotes?: string;

  @Expose()
  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  constructor(partial: Partial<UserEntity>) {
    Object.assign(this, partial);
  }
}
```

## Gắn `ClassSerializerInterceptor`

Gắn `ClassSerializerInterceptor` ở phạm vi method, controller hoặc toàn cục, và tùy chỉnh tùy chọn cho từng route bằng `@SerializeOptions()`:

@@filename(users.controller.ts)

```ts
import { Controller, Get, UseInterceptors } from "@bunest/core";
import {
  ClassSerializerInterceptor,
  SerializeOptions,
} from "@bunest/validation";
import { UserEntity } from "./user.entity";

@UseInterceptors(ClassSerializerInterceptor)
@Controller("users")
export class UsersController {
  @Get("me")
  findCurrentUser(): UserEntity {
    return new UserEntity({
      id: "u_1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@bunest.dev",
      passwordHash: "secret-bcrypt-hash",
      internalNotes: "VIP",
    });
    // Returns: { id, firstName, lastName, email, fullName: "Ada Lovelace" }
  }

  @Get("admin-view")
  @SerializeOptions({ groups: ["admin"] })
  findForAdmin(): UserEntity {
    return new UserEntity({
      id: "u_1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@bunest.dev",
      passwordHash: "secret-bcrypt-hash",
      internalNotes: "VIP",
    });
    // Includes `internalNotes`, still strips `passwordHash`!
  }
}
```

## Ánh xạ Plain Object với `type`

Nếu service của bạn trả về plain object từ SQLite/SQL thay vì class instance, hãy truyền `type: UserEntity` vào trong `@SerializeOptions({ type: UserEntity })`. `ClassSerializerInterceptor` sẽ tự động chạy `plainToInstance(type, value)` trước khi gọi `instanceToPlain()`:

```ts
@Get("plain")
@SerializeOptions({ type: UserEntity, excludeExtraneousValues: false })
findPlainRow() {
  return { id: "u_2", firstName: "Grace", lastName: "Hopper", passwordHash: "hidden" };
}
```

> tip **Đảm bảo truyền thẳng các kiểu gốc của Bun** `ClassSerializerInterceptor` tự động nhận diện và cho đi qua nguyên vẹn các đối tượng `Response`, `ReadableStream`, `Blob`/`BunFile`, `Uint8Array`/`ArrayBuffer`, `AsyncIterable` (`@Sse`), `Date`, `FormData`, và các kiểu nguyên thủy (primitives)!
