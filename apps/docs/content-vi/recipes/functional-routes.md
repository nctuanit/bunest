# Functional Routes & Biên dịch Single Binary

Bạn muốn sự gọn nhẹ kiểu Hono hay Elysia cho microservice nhỏ, webhook receiver hoặc serverless handler — nhưng vẫn giữ nguyên DI container, Guards, Pipes, Interceptors, Exception Filters và OpenAPI 3.1 của Bunest?

Hãy dùng **`defineRoutes()`** kết hợp **`BunestFactory.createRoutes()`** (hoặc `BunestFactory.createAuto({ routes })`).

## 1. Microservice không cần `@Controller` trong 1 file

Mọi route khai báo qua `defineRoutes()` đều được biên dịch vào đúng hybrid `Bun.serve` router và pipeline 11 bước y hệt class `@Controller()`.

@@filename(src/app.ts)

```ts
import { BunestFactory, Injectable, defineRoutes } from "@bunest/core";
import { s } from "@bunest/validation/schema";

@Injectable()
export class NotesStore {
  private readonly notes = new Map<string, { id: string; text: string }>();

  list() {
    return [...this.notes.values()];
  }

  add(text: string) {
    const id = `note_${this.notes.size + 1}`;
    const note = { id, text };
    this.notes.set(id, note);
    return note;
  }
}

const NoteSchema = s.object({ id: s.string(), text: s.string() });

export const notesRoutes = defineRoutes("/notes", { tags: ["Notes"] })
  .get("/", {
    summary: "Lấy danh sách ghi chú",
    responseSchema: s.array(NoteSchema),
    handler: (_ctx, app) => app.get(NotesStore).list(),
  })
  .post("/", {
    summary: "Tạo ghi chú mới",
    httpCode: 201,
    body: s.object({ text: s.string().min(1) }),
    responseSchema: NoteSchema,
    handler: ({ body }, app) => app.get(NotesStore).add(body.text),
  });

export async function createNotesApp() {
  return BunestFactory.createRoutes(notesRoutes, {
    providers: [NotesStore],
  });
}
```

Khởi chạy server chỉ với 2 dòng:

@@filename(src/main.ts)

```ts
import { createNotesApp } from "./app";

const app = await createNotesApp();
await app.listen(Number(Bun.env.PORT ?? 3000));
```

## 2. Kết hợp với `BunestFactory.createAuto()`

Nếu bạn đang dùng cơ chế tự quét module theo thư mục, chỉ cần truyền thêm `routes` vào `BunestFactory.createAuto()` để functional routes chạy song song cùng các `@Controller`:

```ts
const app = await BunestFactory.createAuto({
  dir: import.meta.dir,
  routes: [notesRoutes, healthRoutes],
});
await app.listen(3000);
```

## 3. Xuất chuẩn Web `fetch` Handler

Để nhúng vào edge runtime, `Bun.serve` tùy biến hoặc test trực tiếp, hãy gọi `app.createFetchHandler()`:

```ts
const app = await createNotesApp();
await app.init();

const fetchHandler = app.createFetchHandler();

export default {
  fetch: fetchHandler,
};
```

## 4. Biên dịch thành Single Binary độc lập (`bunest build --compile`)

Các ứng dụng NestJS truyền thống thường gặp lỗi khi bundle hoặc đóng gói binary vì `emitDecoratorMetadata` dễ bị mất trong quá trình đóng gói.

Trong Bunest, cả `bunest build` và `bunest build --compile` đều tự động chạy **`createBunestPlugin({ aotDiMetadata: true })`**, sinh tĩnh toàn bộ DI metadata của constructor trước khi biên dịch binary:

```bash
# Bundle ra dist/main.js kèm AOT DI metadata
bunest build

# Biên dịch thành một file thực thi gốc duy nhất
bunest build --compile --outfile dist/notes-api
./dist/notes-api
```

Bạn vẫn có thể tùy chỉnh plugin trong `bunest.config.ts` khi cần:

```ts
import { defineBunestConfig } from "@bunest/cli";

export default defineBunestConfig({
  plugin: {
    aotDiMetadata: true,
    expandAutoModuleGlobs: true,
  },
});
```

> [!TIP]
> Chạy thử ví dụ hoàn chỉnh kèm OpenAPI 3.1 và E2E tests tại [`examples/functional-minimal`](https://github.com/nctuanit/bunest/tree/main/examples/functional-minimal).
