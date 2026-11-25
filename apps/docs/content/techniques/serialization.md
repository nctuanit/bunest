# Serialization

Serialization transforms class instances returned by route handlers into clean plain JSON objects—stripping sensitive fields like `passwordHash`, exposing computed getters, and shaping output by role/group—via **`ClassSerializerInterceptor`** and **`@SerializeOptions()`** from `@bunest/validation`.

## Excluding & Exposing Properties

Decorate your response entity with `@bunest/validation/transformer` decorators (`@Exclude()`, `@Expose()`, `@Transform()` — also compatible with upstream `class-transformer`):

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

## Binding `ClassSerializerInterceptor`

Attach `ClassSerializerInterceptor` at method, controller, or global scope, and customize options per route using `@SerializeOptions()`:

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

## Mapping Plain Objects with `type`

If your service returns plain objects from SQLite/SQL rather than class instances, pass `type: UserEntity` inside `@SerializeOptions({ type: UserEntity })`. `ClassSerializerInterceptor` automatically runs `plainToInstance(type, value)` before `instanceToPlain()`:

```ts
@Get("plain")
@SerializeOptions({ type: UserEntity, excludeExtraneousValues: false })
findPlainRow() {
  return { id: "u_2", firstName: "Grace", lastName: "Hopper", passwordHash: "hidden" };
}
```

> tip **Native Bun Passthrough Guaranteed** `ClassSerializerInterceptor` automatically detects and passes through `Response`, `ReadableStream`, `Blob`/`BunFile`, `Uint8Array`/`ArrayBuffer`, `AsyncIterable` (`@Sse`), `Date`, `FormData`, and primitives untouched!
