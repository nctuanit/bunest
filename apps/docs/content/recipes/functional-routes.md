# Functional Routes & Single Binaries

Need Hono- or Elysia-level brevity for a small service, webhook receiver, or serverless function — without giving up Bunest's DI container, Guards, Pipes, Interceptors, Exception Filters, or OpenAPI 3.1 generation?

Use **`defineRoutes()`** together with **`BunestFactory.createRoutes()`** (or `BunestFactory.createAuto({ routes })`).

## 1. Zero-Decorator Microservice in One File

Every route defined with `defineRoutes()` compiles into the exact same hybrid `Bun.serve` router and 11-stage execution pipeline as `@Controller()` classes.

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
    summary: "List all notes",
    responseSchema: s.array(NoteSchema),
    handler: (_ctx, app) => app.get(NotesStore).list(),
  })
  .post("/", {
    summary: "Create a note",
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

Boot the server in two lines:

@@filename(src/main.ts)

```ts
import { createNotesApp } from "./app";

const app = await createNotesApp();
await app.listen(Number(Bun.env.PORT ?? 3000));
```

## 2. Combine with `BunestFactory.createAuto()`

Already using file-based module auto-discovery? Pass `routes` directly to `BunestFactory.createAuto()` so functional routes live side-by-side with `@Controller` classes:

```ts
const app = await BunestFactory.createAuto({
  dir: import.meta.dir,
  routes: [notesRoutes, healthRoutes],
});
await app.listen(3000);
```

## 3. Export a Standard Web `fetch` Handler

For edge runtimes, custom `Bun.serve` integrations, or tests, call `app.createFetchHandler()`:

```ts
const app = await createNotesApp();
await app.init();

const fetchHandler = app.createFetchHandler();

export default {
  fetch: fetchHandler,
};
```

## 4. Compile to a Standalone Single Binary (`bunest build --compile`)

Traditional NestJS apps struggle with bundlers and single-file executables because `emitDecoratorMetadata` requires TypeScript's reflection emission to survive bundling.

In Bunest, both `bunest build` and `bunest build --compile` automatically run **`createBunestPlugin({ aotDiMetadata: true })`**, emitting static constructor DI metadata during bundling before compiling the binary:

```bash
# Bundle into dist/main.js with AOT DI metadata
bunest build

# Compile into a self-contained native executable
bunest build --compile --outfile dist/notes-api
./dist/notes-api
```

You can still override plugin options in `bunest.config.ts` if needed:

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
> Try the full runnable example with OpenAPI 3.1 and E2E tests in [`examples/functional-minimal`](https://github.com/nctuanit/bunest/tree/main/examples/functional-minimal).
