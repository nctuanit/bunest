import { describe, expect, it } from "bun:test";
import {
  FunctionalModule,
  Injectable,
  Module,
  type StandardSchemaV1,
} from "@bunest/core";
import {
  HttpClientValidationError,
  defineContract,
  defineRoute,
} from "@bunest/core/client";
import { Test, createContractTestClient } from "../src/index";

function makeSchema<T>(
  validate: (
    value: unknown,
  ) =>
    | { value: T }
    | { issues: Array<{ message: string; path?: PropertyKey[] }> },
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate,
    },
  };
}

describe("createContractTestClient() & TestingModule.createContractClient()", () => {
  const NoteSchema = makeSchema<{ id: string; body: string }>((raw) => {
    const rec = (raw ?? {}) as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.body !== "string") {
      return { issues: [{ message: "invalid note" }] };
    }
    return { value: { id: rec.id, body: rec.body } };
  });

  const NoteListSchema = makeSchema<Array<{ id: string; body: string }>>((raw) =>
    Array.isArray(raw)
      ? { value: raw as Array<{ id: string; body: string }> }
      : { issues: [{ message: "expected array" }] },
  );

  const CreateNoteBodySchema = makeSchema<{ body: string }>((raw) => {
    const rec = (raw ?? {}) as Record<string, unknown>;
    if (typeof rec.body !== "string" || rec.body.length < 2) {
      return { issues: [{ message: "body must be >= 2 chars", path: ["body"] }] };
    }
    return { value: { body: rec.body } };
  });

  const notesContract = defineContract(
    {
      notes: {
        list: defineRoute({
          method: "GET",
          path: "/notes",
          response: NoteListSchema,
        }),
        create: defineRoute({
          method: "POST",
          path: "/notes",
          body: CreateNoteBodySchema,
          response: NoteSchema,
        }),
      },
    },
    { basePath: "/api" },
  );

  it("dispatches zero-socket typed RPC calls directly through app.fetch()", async () => {
    @Injectable()
    class NotesService {
      private readonly rows: Array<{ id: string; body: string }> = [];

      list() {
        return [...this.rows];
      }

      add(body: string) {
        const entry = { id: `n_${this.rows.length + 1}`, body };
        this.rows.push(entry);
        return entry;
      }
    }

    @Module({
      imports: [
        FunctionalModule.forContract(
          notesContract,
          {
            notes: {
              list: ({ get }) => get(NotesService).list(),
              create: ({ body, get }) => get(NotesService).add(body.body),
            },
          },
          { providers: [NotesService] },
        ),
      ],
    })
    class NotesAppModule {}

    const mod = await Test.createTestingModule({
      imports: [NotesAppModule],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    try {
      const client = mod.createContractClient(notesContract, app);
      const created = await client.notes.create({
        body: { body: "Zero-socket typed E2E!" },
      });
      expect(created.status).toBe(201);
      expect(created.data).toEqual({
        id: "n_1",
        body: "Zero-socket typed E2E!",
      });

      // Standalone helper works identically
      const directClient = createContractTestClient(app, notesContract);
      const list = await directClient.notes.list();
      expect(list.status).toBe(200);
      expect(list.data).toEqual([
        { id: "n_1", body: "Zero-socket typed E2E!" },
      ]);

      // Client-side validation catches invalid payloads before hitting server
      await expect(
        client.notes.create({ body: { body: "x" } }),
      ).rejects.toBeInstanceOf(HttpClientValidationError);
    } finally {
      await app.close();
    }
  });
});
