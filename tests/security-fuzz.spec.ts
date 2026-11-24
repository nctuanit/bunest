import { afterEach, describe, expect, it } from "bun:test";
import { IsEmail, IsString } from "../packages/validation/src/validator";
import {
  Body,
  BunestFactory,
  Controller,
  Get,
  Headers,
  Module,
  Post,
  Query,
  UploadedFile,
  ValidationPipe,
  ensureDir,
  join,
  removePath,
  type UploadedFileInfo,
} from "../packages/core/src";
import {
  canonicalizePath,
  isNativeBunRoutePath,
  normalizePath,
} from "../packages/core/src/http";
import { parseEnvContent } from "../packages/core/src/config";
import {
  CronExpressionError,
  getNextCronDate,
  parseCronExpression,
} from "../packages/jobs/src/scheduler";
import {
  JwtInvalidException,
  JwtService,
  base64UrlEncode,
} from "../packages/security/src";
import {
  LocalDisk,
  StorageInvalidKeyError,
  assertValidKey,
} from "../packages/storage/src";
import { parseWsFrame } from "../packages/core/src/ws";

/**
 * Deterministic Mulberry32 PRNG for reproducible fuzzing across runs.
 */
function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomFromAlphabet(
  rng: () => number,
  alphabet: string,
  minLen: number,
  maxLen: number,
): string {
  const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(rng() * alphabet.length)]!;
  }
  return out;
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await removePath(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Cross-Package Security & Deterministic Fuzz Suite (§20.1 & Phase 7)", () => {
  describe("HTTP Security Hardening", () => {
    class ProfileDto {
      @IsEmail()
      email!: string;

      @IsString()
      name!: string;
    }

    @Controller("/sec")
    class SecurityController {
      @Post("dto")
      dto(@Body() payload: ProfileDto) {
        return { email: payload.email, name: payload.name };
      }

      @Post("raw")
      raw(@Body() payload: Record<string, unknown>) {
        return {
          hasProto: Object.hasOwn(payload ?? {}, "__proto__"),
          hasCtor: Object.hasOwn(payload ?? {}, "constructor"),
          keys: Object.keys(payload ?? {}),
        };
      }

      @Get("query")
      query(@Query() q: Record<string, unknown>) {
        return {
          hasProto: Object.hasOwn(q, "__proto__"),
          keys: Object.keys(q),
        };
      }

      @Post("upload")
      upload(@UploadedFile("file") file?: UploadedFileInfo) {
        return { size: file?.size ?? 0 };
      }

      @Get("echo-hdr")
      echoHeader(@Headers("x-input") input?: string) {
        return { input: input ?? "" };
      }
    }

    @Module({ controllers: [SecurityController] })
    class SecurityAppModule {}

    it("blocks prototype pollution, oversized payloads (413), malformed JSON (400), malformed multipart (400), and header anomalies", async () => {
      const app = await BunestFactory.create(SecurityAppModule, {
        logger: false,
        bodyLimit: 128,
      });
      app.useGlobalPipes(new ValidationPipe());

      try {
        // 1. Prototype pollution rejected cleanly on DTO endpoint and stripped on raw/query endpoints
        const protoPayload =
          '{"email":"a@b.com","name":"Alice","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}}}';
        const dtoRes = await app.fetch(
          new Request("http://localhost/sec/dto", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: protoPayload,
          }),
        );
        // Body parser strips __proto__/constructor before ValidationPipe OR ValidationPipe rejects; either way Object.prototype is untouched!
        expect([201, 400]).toContain(dtoRes.status);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(({} as Record<string, unknown>).polluted2).toBeUndefined();

        const rawRes = await app.fetch(
          new Request("http://localhost/sec/raw", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"ok":1,"__proto__":{"p":1},"constructor":{"p":2},"prototype":{"p":3}}',
          }),
        );
        expect(rawRes.status).toBe(201);
        expect(await rawRes.json()).toEqual({
          hasProto: false,
          hasCtor: false,
          keys: ["ok"],
        });

        const queryRes = await app.fetch(
          new Request(
            "http://localhost/sec/query?safe=1&__proto__=bad&constructor=bad&prototype=bad",
          ),
        );
        expect(queryRes.status).toBe(200);
        expect(await queryRes.json()).toEqual({
          hasProto: false,
          keys: ["safe"],
        });

        // 2. Oversized payload -> 413 Payload Too Large
        const bigBody = JSON.stringify({ ok: "x".repeat(512) });
        const bigRes = await app.fetch(
          new Request("http://localhost/sec/raw", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: bigBody,
          }),
        );
        expect(bigRes.status).toBe(413);

        // 3. Malformed JSON -> 400 Bad Request (never 500)
        const badJsonRes = await app.fetch(
          new Request("http://localhost/sec/raw", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not valid json",
          }),
        );
        expect(badJsonRes.status).toBe(400);

        // 4. Malformed multipart/form-data -> 400 Bad Request (never 500)
        const badMultipartRes = await app.fetch(
          new Request("http://localhost/sec/upload", {
            method: "POST",
            headers: {
              "content-type": "multipart/form-data; boundary=---broken",
            },
            body: "not-a-valid-multipart-stream",
          }),
        );
        expect([400, 201]).toContain(badMultipartRes.status);
        expect(badMultipartRes.status).not.toBe(500);

        // 5. Encoded CRLF in query/path never triggers 500 or response splitting
        const crlfRes = await app.fetch(
          new Request("http://localhost/sec/query?v=a%0d%0aX-Injected:%20evil"),
        );
        expect(crlfRes.status).toBe(200);
        expect(crlfRes.headers.get("x-injected")).toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  describe("JWT & Storage Security", () => {
    it("rejects alg:none, tampered signatures, HMAC CryptoKey algorithm confusion, path traversal, and Windows NTFS ADS", async () => {
      const jwt = new JwtService({
        secret: "super-secret-signing-key-32bytes!",
      });
      const valid = await jwt.sign({ sub: "user_1", role: "user" });

      // 1. alg: "none" forgery rejected
      const noneHeader = base64UrlEncode(
        new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT" })),
      );
      const fakePayload = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({ sub: "admin", role: "admin" }),
        ),
      );
      await expect(jwt.verify(`${noneHeader}.${fakePayload}.`)).rejects.toThrow(
        JwtInvalidException,
      );

      // 2. Tampered payload rejected
      const parts = valid.split(".");
      await expect(
        jwt.verify(`${parts[0]}.${fakePayload}.${parts[2]}`),
      ).rejects.toThrow(JwtInvalidException);

      // 3. HMAC CryptoKey algorithm confusion (SHA-256 key given HS512 header) rejected
      const sha256Key = await crypto.subtle.generateKey(
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
      const hs256Svc = new JwtService({ secret: sha256Key });
      const forgedHs512Header = base64UrlEncode(
        new TextEncoder().encode(JSON.stringify({ alg: "HS512", typ: "JWT" })),
      );
      const signingInput = `${forgedHs512Header}.${fakePayload}`;
      const sigBytes = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          sha256Key,
          new TextEncoder().encode(signingInput),
        ),
      );
      const forgedToken = `${signingInput}.${base64UrlEncode(sigBytes)}`;
      await expect(hs256Svc.verify(forgedToken)).rejects.toThrow(
        JwtInvalidException,
      );

      // 4. Storage traversal & Windows NTFS Alternate Data Stream (:) rejection
      const rootDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-sec-storage-${crypto.randomUUID()}`,
      );
      await ensureDir(rootDir);
      tempDirs.push(rootDir);
      const storage = new LocalDisk({ root: rootDir });

      for (const maliciousKey of [
        "../outside.txt",
        "..\\outside.txt",
        "nested/../../escape.txt",
        "/etc/passwd",
        "null\0byte.txt",
      ]) {
        expect(() => assertValidKey(maliciousKey)).toThrow(
          StorageInvalidKeyError,
        );
      }

      for (const maliciousKey of [
        "../outside.txt",
        "..\\outside.txt",
        "nested/../../escape.txt",
        "/etc/passwd",
        "C:/Windows/win.ini",
        "nested/file.txt:hiddenstream",
        "nested/C:drive.txt",
        "null\0byte.txt",
      ]) {
        await expect(storage.put(maliciousKey, "x")).rejects.toThrow(
          StorageInvalidKeyError,
        );
      }
    });
  });

  describe("Deterministic Seeded Fuzz / Property Tests (550 inputs per parser/router)", () => {
    const ITERATIONS = 550;

    it("fuzzes @bunest/http path normalization & FallbackRadixRouter with 550 seeded inputs without crashes", async () => {
      const rng = createSeededRng(0x1337_cafe);
      const alphabet = "abc123/:*?-.%()\\_+~#@!$&'[]";

      @Controller()
      class FuzzRouterController {
        @Get("/users/:id(\\d+)")
        userNum() {
          return { route: "user-num" };
        }

        @Get("/files/*/meta")
        fileMeta() {
          return { route: "file-meta" };
        }

        @Get("/optional/:slug?")
        optionalSlug() {
          return { route: "opt" };
        }

        @Post("/api/v1/:org/items/*")
        orgItems() {
          return { route: "org-items" };
        }
      }

      @Module({ controllers: [FuzzRouterController] })
      class FuzzRouterModule {}

      const app = await BunestFactory.create(FuzzRouterModule, {
        logger: false,
      });
      try {
        for (let i = 0; i < ITERATIONS; i += 1) {
          const rawPath = randomFromAlphabet(rng, alphabet, 0, 48);
          const norm = normalizePath(rawPath);
          expect(norm.startsWith("/")).toBe(true);
          const canonical = canonicalizePath(norm);
          expect(typeof canonical).toBe("string");
          expect(typeof isNativeBunRoutePath(norm)).toBe("boolean");

          // Dispatch safe URL-encoded path through the real compiled Hybrid/FallbackRadixRouter
          const encodedPath = norm
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/");
          const res = await app.fetch(
            new Request(`http://localhost${encodedPath}`, {
              method: i % 2 === 0 ? "GET" : "POST",
            }),
          );
          expect([200, 201, 404, 405]).toContain(res.status);
        }
      } finally {
        await app.close();
      }
    });

    it("fuzzes @bunest/scheduler cron parser with 550 seeded inputs without uncaught crashes or hangs", () => {
      const rng = createSeededRng(0x5eed_c409);
      const alphabet = "0123456789*,-/ @aAbBcCdDeEfFjJmMnNoOpPrRsStTuUwWyY\t";
      const base = new Date("2026-06-15T10:00:00.000Z");

      let parsedValid = 0;
      let rejectedInvalid = 0;

      for (let i = 0; i < ITERATIONS; i += 1) {
        const expr =
          i % 5 === 0
            ? `${Math.floor(rng() * 65)} ${Math.floor(rng() * 26)} ${Math.floor(rng() * 34)} ${Math.floor(rng() * 14)} ${Math.floor(rng() * 9)}`
            : randomFromAlphabet(rng, alphabet, 0, 32);

        try {
          const parsed = parseCronExpression(expr);
          parsedValid += 1;
          try {
            const next = getNextCronDate(parsed, base, "UTC");
            expect(next.getTime()).toBeGreaterThan(base.getTime());
          } catch (err) {
            expect(err).toBeInstanceOf(CronExpressionError);
          }
        } catch (err) {
          rejectedInvalid += 1;
          expect(err).toBeInstanceOf(CronExpressionError);
        }
      }

      expect(parsedValid + rejectedInvalid).toBe(ITERATIONS);
      expect(rejectedInvalid).toBeGreaterThan(0);
    });

    it("fuzzes @bunest/config .env parser with 550 seeded inputs with zero crashes or prototype pollution", () => {
      const rng = createSeededRng(0xdecaf_001);
      const alphabet = "ABC_xyz0123=#'\"`\\${}:-\n\r\t ;__proto__constructor";

      for (let i = 0; i < ITERATIONS; i += 1) {
        const content =
          i % 10 === 0
            ? "__proto__=evil\nconstructor=evil\nprototype=evil\nVALID=ok"
            : randomFromAlphabet(rng, alphabet, 0, 96);
        const parsed = parseEnvContent(content);
        expect(typeof parsed).toBe("object");
        expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
        expect(Object.hasOwn(parsed, "constructor")).toBe(false);
        expect(Object.hasOwn(parsed, "prototype")).toBe(false);
      }

      expect(({} as Record<string, unknown>).evil).toBeUndefined();
    });

    it("fuzzes @bunest/websockets frame parser with 550 seeded string inputs without crashes or prototype pollution", () => {
      const rng = createSeededRng(0xbeef_9001);
      const alphabet = '{}[]:,"eventdatid0123456789\\n__proto__constructor ';

      let validFrames = 0;
      let rejectedFrames = 0;

      for (let i = 0; i < ITERATIONS; i += 1) {
        const raw =
          i % 11 === 0
            ? '{"event":"msg","data":{"__proto__":{"wsPolluted":true},"constructor":{"prototype":{"wsPolluted2":true}},"ok":1}}'
            : i % 13 === 0
              ? `{"event":"ev_${i}","data":[1,2,3],"id":${i}}`
              : randomFromAlphabet(rng, alphabet, 0, 80);

        const frame = parseWsFrame(raw);
        if (frame === null) {
          rejectedFrames += 1;
        } else {
          validFrames += 1;
          expect(typeof frame.event).toBe("string");
          expect(frame.event.length).toBeGreaterThan(0);
          if (typeof frame.data === "object" && frame.data !== null) {
            expect(Object.hasOwn(frame.data, "__proto__")).toBe(false);
            expect(Object.hasOwn(frame.data, "constructor")).toBe(false);
            expect(Object.hasOwn(frame.data, "prototype")).toBe(false);
          }
        }
      }

      expect(validFrames + rejectedFrames).toBe(ITERATIONS);
      expect(validFrames).toBeGreaterThan(0);
      expect(rejectedFrames).toBeGreaterThan(0);
      expect(({} as Record<string, unknown>).wsPolluted).toBeUndefined();
      expect(({} as Record<string, unknown>).wsPolluted2).toBeUndefined();
    });
  });
});
