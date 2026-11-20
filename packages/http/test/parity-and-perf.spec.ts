import "reflect-metadata";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Body,
  BODY_SANITIZED_SYMBOL,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  type PipeTransform,
  Post,
  RawBody,
  Res,
  type ResponseContext,
  StreamableFile,
  UploadedFile,
  UploadedFiles,
  UsePipes,
  Version,
  VERSION_NEUTRAL,
  VersioningType,
} from "@bunest/common";
import {
  BunHttpAdapter,
  CompressionMiddleware,
  createStaticAssetsMount,
  DefaultHttpRuntimeBridge,
  type DiskUploadedFileInfo,
  DuplicateRouteException,
  getCurrentRequestContext,
  type HttpRuntimeBridge,
  tryServeStaticAsset,
} from "../src/index";

const tempDirs: string[] = [];
const activeAdapters: BunHttpAdapter[] = [];

afterEach(async () => {
  while (activeAdapters.length > 0) {
    const adapter = activeAdapters.pop();
    if (adapter) {
      await adapter.close(true);
    }
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("P0 #2 — Fast-Path JSON Body Parsing, BODY_SANITIZED_SYMBOL & Hot-Path Correctness", () => {
  test("takes fast-path JSON parsing with Content-Length, marks BODY_SANITIZED_SYMBOL, and strips prototype-pollution + unicode-escaped keys", async () => {
    const seenSymbols: boolean[] = [];

    @Controller("/fast-json")
    class FastJsonController {
      @Post("echo")
      echo(@Body() body: Record<string, unknown>) {
        seenSymbols.push(
          Boolean(
            body &&
              (body as Record<symbol, unknown>)[BODY_SANITIZED_SYMBOL] === true,
          ),
        );
        return {
          keys: Object.keys(body),
          body,
          hasProto: Object.hasOwn(body, "__proto__"),
          hasCtor: Object.hasOwn(body, "constructor"),
          hasPrototype: Object.hasOwn(body, "prototype"),
        };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false, bodyLimit: 512 });
    await adapter.compileControllers([FastJsonController]);

    // 1. Clean JSON payload with explicit Content-Length -> 1-pass fast path (no cloning) + non-enumerable symbol
    const cleanJson = JSON.stringify({ name: "Alice", age: 28, active: true });
    const cleanRes = await adapter.fetch(
      new Request("http://localhost/fast-json/echo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(cleanJson, "utf8")),
        },
        body: cleanJson,
      }),
    );
    expect(cleanRes.status).toBe(201);
    expect(await cleanRes.json()).toEqual({
      keys: ["name", "age", "active"],
      body: { name: "Alice", age: 28, active: true },
      hasProto: false,
      hasCtor: false,
      hasPrototype: false,
    });
    expect(seenSymbols[0]).toBe(true);

    // 2. Dangerous keys WITH Content-Length -> stripped deeply, Object.prototype untouched, still marked sanitized
    const attackJson =
      '{"safe":"I am a constructor","__proto__":{"pwn":1},"nested":{"constructor":{"x":1},"prototype":{"y":2},"ok":true}}';
    const attackRes = await adapter.fetch(
      new Request("http://localhost/fast-json/echo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(attackJson, "utf8")),
        },
        body: attackJson,
      }),
    );
    expect(attackRes.status).toBe(201);
    expect(await attackRes.json()).toEqual({
      keys: ["safe", "nested"],
      body: { safe: "I am a constructor", nested: { ok: true } },
      hasProto: false,
      hasCtor: false,
      hasPrototype: false,
    });
    expect(seenSymbols[1]).toBe(true);
    expect(({} as Record<string, unknown>).pwn).toBeUndefined();

    // 3. Unicode-escaped `__proto__` key (`\u005f\u005fproto\u005f\u005f`) -> detected via `\u` guard and stripped!
    const unicodeAttack =
      '{"ok":1,"\\u005f\\u005fproto\\u005f\\u005f":{"unicodePwn":true}}';
    const unicodeRes = await adapter.fetch(
      new Request("http://localhost/fast-json/echo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(unicodeAttack, "utf8")),
        },
        body: unicodeAttack,
      }),
    );
    expect(unicodeRes.status).toBe(201);
    expect(await unicodeRes.json()).toEqual({
      keys: ["ok"],
      body: { ok: 1 },
      hasProto: false,
      hasCtor: false,
      hasPrototype: false,
    });
    expect(seenSymbols[2]).toBe(true);
    expect(({} as Record<string, unknown>).unicodePwn).toBeUndefined();
  });

  test("enforces 413 Payload Too Large (with CL, spoofed CL + multi-byte UTF-8, and chunked stream without CL) and 400 malformed JSON", async () => {
    @Controller("/strict-limits")
    class StrictLimitsController {
      @Post("json")
      accept(@Body() body: unknown) {
        return { ok: true, body };
      }

      @Post("no-body-param")
      noBodyParam() {
        return { ok: true };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false, bodyLimit: 24 });
    await adapter.compileControllers([StrictLimitsController]);

    // 1. Oversized WITH matching Content-Length -> 413
    const big = JSON.stringify({ data: "a".repeat(64) });
    const res1 = await adapter.fetch(
      new Request("http://localhost/strict-limits/json", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(big.length),
        },
        body: big,
      }),
    );
    expect(res1.status).toBe(413);

    // 2. Spoofed small Content-Length with multi-byte UTF-8 payload exceeding maxBodyBytes -> 413
    const utf8Over = JSON.stringify({ s: "🎉🎉🎉🎉🎉🎉🎉" }); // 7 emojis = 28 bytes + JSON wrapper > 24 bytes
    const res2 = await adapter.fetch(
      new Request("http://localhost/strict-limits/json", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "10",
        },
        body: utf8Over,
      }),
    );
    expect(res2.status).toBe(413);

    // 3. Chunked stream WITHOUT Content-Length -> 413
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":"0123456789'));
        controller.enqueue(new TextEncoder().encode('0123456789012345"}'));
        controller.close();
      },
    });
    const res3 = await adapter.fetch(
      new Request("http://localhost/strict-limits/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
      }),
    );
    expect(res3.status).toBe(413);

    // 4. Oversized Content-Length rejected even on route without @Body()
    const res4 = await adapter.fetch(
      new Request("http://localhost/strict-limits/no-body-param", {
        method: "POST",
        headers: { "content-length": "999" },
        body: "x".repeat(50),
      }),
    );
    expect(res4.status).toBe(413);

    // 5. Malformed JSON WITH Content-Length -> 400
    const bad = '{"broken":';
    const res5 = await adapter.fetch(
      new Request("http://localhost/strict-limits/json", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(bad.length),
        },
        body: bad,
      }),
    );
    expect(res5.status).toBe(400);

    // 6. Malformed JSON WITHOUT Content-Length -> 400
    const res6 = await adapter.fetch(
      new Request("http://localhost/strict-limits/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bad,
      }),
    );
    expect(res6.status).toBe(400);
  });

  test("preserves ALS, @Res() mutations, HEAD stripping, and circular JSON 500 on fast singleton routes", async () => {
    @Controller("/fast-edge")
    class FastEdgeController {
      @Get("sync-als")
      syncAls() {
        const ctx = getCurrentRequestContext();
        ctx?.responseContext.header("X-From-Als", "yes");
        return { path: ctx?.pathname };
      }

      @Get("async-als/:id")
      async asyncAls(@Param("id") id: string) {
        await Promise.resolve();
        const ctx = getCurrentRequestContext();
        return { id, alsId: ctx?.params.id };
      }

      @Get("res-status")
      resStatus(@Res() res: ResponseContext) {
        res.status(202).header("X-Custom", "ok");
        return { accepted: true };
      }

      @Get("circular")
      circular() {
        const a: Record<string, unknown> = { ok: 1 };
        a.self = a;
        return a;
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    await adapter.compileControllers([FastEdgeController]);

    const r1 = await adapter.fetch(new Request("http://localhost/fast-edge/sync-als"));
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-from-als")).toBe("yes");
    expect(await r1.json()).toEqual({ path: "/fast-edge/sync-als" });

    const rHead = await adapter.fetch(
      new Request("http://localhost/fast-edge/sync-als", { method: "HEAD" }),
    );
    expect(rHead.status).toBe(200);
    expect(rHead.headers.get("x-from-als")).toBe("yes");
    expect(await rHead.text()).toBe("");

    const r2 = await adapter.fetch(
      new Request("http://localhost/fast-edge/async-als/u_42"),
    );
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ id: "u_42", alsId: "u_42" });

    const r3 = await adapter.fetch(
      new Request("http://localhost/fast-edge/res-status"),
    );
    expect(r3.status).toBe(202);
    expect(r3.headers.get("x-custom")).toBe("ok");
    expect(await r3.json()).toEqual({ accepted: true });

    const r4 = await adapter.fetch(
      new Request("http://localhost/fast-edge/circular"),
    );
    expect(r4.status).toBe(500);
  });
});

describe("P0 #4 — rawBody: true & @RawBody() for Webhook HMAC Verification", () => {
  async function computeHmacHex(
    secret: string,
    payload: Uint8Array,
  ): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, payload as Uint8Array<ArrayBuffer>),
    );
    return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  test("captures exact untouched wire bytes for HMAC-SHA256 verification alongside @Body() and RequestContext.rawBody", async () => {
    const WEBHOOK_SECRET = "whsec_bunest_super_secret_key";

    @Controller("/webhooks")
    class WebhookController {
      @Post("stripe")
      async handleStripe(
        @RawBody() raw: Uint8Array | undefined,
        @Body() parsed: { event: string; amount: number },
        @Headers("x-signature") sig: string,
      ) {
        if (!raw) {
          return { verified: false, reason: "missing-raw" };
        }
        const expected = await computeHmacHex(WEBHOOK_SECRET, raw);
        const ctxRaw = getCurrentRequestContext()?.rawBody;
        return {
          verified: expected === sig,
          sameRef: ctxRaw === raw,
          rawLength: raw.byteLength,
          rawText: new TextDecoder().decode(raw),
          parsed,
        };
      }
    }

    // 1. Enabled (`rawBody: true`) — live Bun.serve (Content-Length fast path) AND in-memory fetch
    const enabledAdapter = new BunHttpAdapter({
      logger: false,
      rawBody: true,
    });
    activeAdapters.push(enabledAdapter);
    await enabledAdapter.compileControllers([WebhookController]);

    // Deliberately non-canonical JSON formatting (extra spaces & order) to prove exact raw bytes are preserved!
    const exactWireJson = '{  "amount" : 4999 ,  "event" : "invoice.paid"  }';
    const exactWireBytes = new TextEncoder().encode(exactWireJson);
    const validSig = await computeHmacHex(WEBHOOK_SECRET, exactWireBytes);

    // In-memory adapter.fetch()
    const inMemRes = await enabledAdapter.fetch(
      new Request("http://localhost/webhooks/stripe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature": validSig,
        },
        body: exactWireJson,
      }),
    );
    expect(inMemRes.status).toBe(201);
    expect(await inMemRes.json()).toEqual({
      verified: true,
      sameRef: true,
      rawLength: exactWireBytes.byteLength,
      rawText: exactWireJson,
      parsed: { amount: 4999, event: "invoice.paid" },
    });

    // Live Bun.serve({ port: 0 }) with real HTTP/1.1 Content-Length
    const info = await enabledAdapter.listen({ port: 0, hostname: "127.0.0.1" });
    const liveRes = await fetch(`http://127.0.0.1:${info.port}/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": validSig,
      },
      body: exactWireJson,
    });
    expect(liveRes.status).toBe(201);
    expect(await liveRes.json()).toEqual({
      verified: true,
      sameRef: true,
      rawLength: exactWireBytes.byteLength,
      rawText: exactWireJson,
      parsed: { amount: 4999, event: "invoice.paid" },
    });

    // 2. Disabled by default (`rawBody: false`) -> @RawBody() returns undefined
    const disabledAdapter = new BunHttpAdapter({ logger: false });
    await disabledAdapter.compileControllers([WebhookController]);
    const disabledRes = await disabledAdapter.fetch(
      new Request("http://localhost/webhooks/stripe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature": validSig,
        },
        body: exactWireJson,
      }),
    );
    expect(disabledRes.status).toBe(201);
    expect(await disabledRes.json()).toEqual({
      verified: false,
      reason: "missing-raw",
    });
  });
});

describe("P1 #5 — API Versioning (URI, HEADER, MEDIA_TYPE, CUSTOM) & RouterModule Prefixes", () => {
  test("URI versioning: default v prefix, prefix: false, VERSION_NEUTRAL, array versions, method > class > default precedence, globalPrefix, and conflict detection", async () => {
    @Controller({ path: "users", version: "1" })
    class UsersV1Controller {
      @Get()
      list() {
        return { version: "1" };
      }

      @Version("2")
      @Get("profile")
      profileV2() {
        return { version: "2-method-override" };
      }

      @Version(["1", "2"])
      @Get("shared")
      shared() {
        return { version: "1-or-2" };
      }
    }

    @Controller("health")
    @Version(VERSION_NEUTRAL)
    class HealthController {
      @Get()
      check() {
        return { ok: true };
      }
    }

    @Controller("legacy")
    class DefaultVersionedController {
      @Get()
      info() {
        return { version: "default-1" };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.setGlobalPrefix("api", { exclude: ["health"] });
    adapter.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: "1",
    });
    await adapter.compileControllers([
      UsersV1Controller,
      HealthController,
      DefaultVersionedController,
    ]);

    expect(
      await (await adapter.fetch(new Request("http://localhost/api/v1/users"))).json(),
    ).toEqual({ version: "1" });
    expect(
      (await adapter.fetch(new Request("http://localhost/api/v2/users"))).status,
    ).toBe(404);
    expect(
      await (
        await adapter.fetch(new Request("http://localhost/api/v2/users/profile"))
      ).json(),
    ).toEqual({ version: "2-method-override" });
    expect(
      await (
        await adapter.fetch(new Request("http://localhost/api/v1/users/shared"))
      ).json(),
    ).toEqual({ version: "1-or-2" });
    expect(
      await (
        await adapter.fetch(new Request("http://localhost/api/v2/users/shared"))
      ).json(),
    ).toEqual({ version: "1-or-2" });
    expect(
      await (await adapter.fetch(new Request("http://localhost/health"))).json(),
    ).toEqual({ ok: true });
    expect(
      await (await adapter.fetch(new Request("http://localhost/api/v1/legacy"))).json(),
    ).toEqual({ version: "default-1" });

    // URI versioning with prefix: false -> /1/users
    const noPrefixAdapter = new BunHttpAdapter({ logger: false });
    noPrefixAdapter.enableVersioning({
      type: VersioningType.URI,
      prefix: false,
    });
    await noPrefixAdapter.compileControllers([UsersV1Controller]);
    expect(
      await (
        await noPrefixAdapter.fetch(new Request("http://localhost/1/users"))
      ).json(),
    ).toEqual({ version: "1" });

    // Duplicate URI version collision must fail fast
    @Controller({ path: "dup", version: "1" })
    class DupA {
      @Get()
      a() {
        return 1;
      }
    }
    @Controller({ path: "dup", version: ["1", "2"] })
    class DupB {
      @Get()
      b() {
        return 2;
      }
    }
    const dupAdapter = new BunHttpAdapter({ logger: false });
    dupAdapter.enableVersioning({ type: VersioningType.URI });
    await expect(dupAdapter.compileControllers([DupA, DupB])).rejects.toThrow(
      DuplicateRouteException,
    );
  });

  test("HEADER versioning: native + live Bun.serve + FallbackRadixRouter + VERSION_NEUTRAL + version-aware 405/404 + duplicate conflict", async () => {
    @Controller("/items")
    class ItemsV1Controller {
      @Version("1")
      @Get()
      listV1() {
        return { version: "1" };
      }

      @Version("1")
      @Get(":id(\\d+)")
      numV1(@Param("id") id: string) {
        return { version: "1", id };
      }
    }

    @Controller("/items")
    class ItemsV2Controller {
      @Version("2")
      @Get()
      listV2() {
        return { version: "2" };
      }

      @Version("2")
      @Post()
      createV2() {
        return { created: "2" };
      }

      @Version("2")
      @Get(":id(\\d+)")
      numV2(@Param("id") id: string) {
        return { version: "2", id };
      }
    }

    @Controller("/status")
    class StatusController {
      @Version("2")
      @Get()
      v2() {
        return { status: "v2" };
      }

      @Version(VERSION_NEUTRAL)
      @Get()
      neutral() {
        return { status: "neutral" };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    activeAdapters.push(adapter);
    adapter.enableVersioning({
      type: VersioningType.HEADER,
      header: "X-API-Version",
    });
    await adapter.compileControllers([
      ItemsV1Controller,
      ItemsV2Controller,
      StatusController,
    ]);

    const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${info.port}`;

    // V1 & V2 on native path
    expect(
      await (
        await fetch(`${base}/items`, { headers: { "X-API-Version": "1" } })
      ).json(),
    ).toEqual({ version: "1" });
    expect(
      await (
        await fetch(`${base}/items`, { headers: { "X-API-Version": "2" } })
      ).json(),
    ).toEqual({ version: "2" });

    // POST /items works on v2, returns 405 on v1 (Allow: GET, HEAD), returns 404 on unknown v99
    expect(
      (
        await fetch(`${base}/items`, {
          method: "POST",
          headers: { "X-API-Version": "2" },
        })
      ).status,
    ).toBe(201);

    const v1Post = await fetch(`${base}/items`, {
      method: "POST",
      headers: { "X-API-Version": "1" },
    });
    expect(v1Post.status).toBe(405);
    expect(v1Post.headers.get("allow")).toBe("GET, HEAD");

    const v99Get = await fetch(`${base}/items`, {
      headers: { "X-API-Version": "99" },
    });
    expect(v99Get.status).toBe(404);

    // FallbackRadixRouter (regex param) respects HEADER versioning
    expect(
      await (
        await fetch(`${base}/items/42`, { headers: { "X-API-Version": "1" } })
      ).json(),
    ).toEqual({ version: "1", id: "42" });
    expect(
      await (
        await fetch(`${base}/items/42`, { headers: { "X-API-Version": "2" } })
      ).json(),
    ).toEqual({ version: "2", id: "42" });
    expect(
      (await fetch(`${base}/items/42`, { headers: { "X-API-Version": "3" } }))
        .status,
    ).toBe(404);

    // Specific version beats VERSION_NEUTRAL; missing/unknown falls back to VERSION_NEUTRAL
    expect(
      await (
        await fetch(`${base}/status`, { headers: { "X-API-Version": "2" } })
      ).json(),
    ).toEqual({ status: "v2" });
    expect(await (await fetch(`${base}/status`)).json()).toEqual({
      status: "neutral",
    });
    expect(
      await (
        await fetch(`${base}/status`, { headers: { "X-API-Version": "7" } })
      ).json(),
    ).toEqual({ status: "neutral" });

    // Overlapping header versions fail fast
    @Controller("/clash")
    class ClashController {
      @Version("1")
      @Get()
      a() {
        return 1;
      }

      @Version(["1", "2"])
      @Get()
      b() {
        return 2;
      }
    }
    const clashAdapter = new BunHttpAdapter({ logger: false });
    clashAdapter.enableVersioning({
      type: VersioningType.HEADER,
      header: "X-API-Version",
    });
    await expect(
      clashAdapter.compileControllers([ClashController]),
    ).rejects.toThrow(DuplicateRouteException);
  });

  test("MEDIA_TYPE and CUSTOM versioning strategies", async () => {
    @Controller("/catalog")
    class CatalogController {
      @Version("1")
      @Get()
      v1() {
        return { catalog: "v1" };
      }

      @Version("2")
      @Get()
      v2() {
        return { catalog: "v2" };
      }
    }

    // MEDIA_TYPE versioning with key "v="
    const mediaAdapter = new BunHttpAdapter({ logger: false });
    mediaAdapter.enableVersioning({
      type: VersioningType.MEDIA_TYPE,
      key: "v=",
    });
    await mediaAdapter.compileControllers([CatalogController]);

    expect(
      await (
        await mediaAdapter.fetch(
          new Request("http://localhost/catalog", {
            headers: { accept: "application/json;v=1" },
          }),
        )
      ).json(),
    ).toEqual({ catalog: "v1" });

    expect(
      await (
        await mediaAdapter.fetch(
          new Request("http://localhost/catalog", {
            headers: {
              accept: 'application/vnd.bunest+json; v="2"; charset=utf-8',
            },
          }),
        )
      ).json(),
    ).toEqual({ catalog: "v2" });

    // Media-range preference order: v=3 (absent), then v=1 (matched)
    expect(
      await (
        await mediaAdapter.fetch(
          new Request("http://localhost/catalog", {
            headers: {
              accept: "application/json;v=3, application/json;v=1",
            },
          }),
        )
      ).json(),
    ).toEqual({ catalog: "v1" });

    expect(
      (
        await mediaAdapter.fetch(
          new Request("http://localhost/catalog", {
            headers: { accept: "application/json" },
          }),
        )
      ).status,
    ).toBe(404);

    // CUSTOM versioning extractor returning priority-ordered string[]
    const customAdapter = new BunHttpAdapter({ logger: false });
    customAdapter.enableVersioning({
      type: VersioningType.CUSTOM,
      extractor: (req) => {
        const hdr = req.headers.get("x-custom-versions");
        return hdr ? hdr.split(",").map((s) => s.trim()) : [];
      },
    });
    await customAdapter.compileControllers([CatalogController]);

    expect(
      await (
        await customAdapter.fetch(
          new Request("http://localhost/catalog", {
            headers: { "x-custom-versions": "3, 2, 1" },
          }),
        )
      ).json(),
    ).toEqual({ catalog: "v2" });

    expect(
      (
        await customAdapter.fetch(
          new Request("http://localhost/catalog", {
            headers: { "x-custom-versions": "9" },
          }),
        )
      ).status,
    ).toBe(404);
  });

  test("setControllerPrefixes combines cleanly with globalPrefix, URI versioning, controller path, and method path", async () => {
    @Controller("users")
    @Version("1")
    class AdminUsersController {
      @Get("list")
      list() {
        return { scope: "admin-users" };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.setGlobalPrefix("api");
    adapter.enableVersioning({ type: VersioningType.URI });
    adapter.setControllerPrefixes(
      new Map([[AdminUsersController, ["/admin", "/internal/admin"]]]),
    );
    await adapter.compileControllers([AdminUsersController]);

    expect(
      await (
        await adapter.fetch(new Request("http://localhost/api/v1/admin/users/list"))
      ).json(),
    ).toEqual({ scope: "admin-users" });

    expect(
      await (
        await adapter.fetch(
          new Request("http://localhost/api/v1/internal/admin/users/list"),
        )
      ).json(),
    ).toEqual({ scope: "admin-users" });

    // Single string value also supported
    const singlePrefixAdapter = new BunHttpAdapter({ logger: false });
    singlePrefixAdapter.setControllerPrefixes(
      new Map([[AdminUsersController, "tenant"]]),
    );
    await singlePrefixAdapter.compileControllers([AdminUsersController]);
    expect(
      await (
        await singlePrefixAdapter.fetch(
          new Request("http://localhost/tenant/users/list"),
        )
      ).json(),
    ).toEqual({ scope: "admin-users" });
  });
});

describe("P1 #6 — StreamableFile, useStaticAssets (with Security Defenses), & Streaming Multipart Disk Storage", () => {
  test("serializes StreamableFile (ReadableStream, Uint8Array, Bun.file) streaming directly without RAM buffering", async () => {
    const dir = await makeTempDir("bunest-streamable-");
    const diskPath = join(dir, "report.txt");
    await writeFile(diskPath, "bun-file-report-content");

    let streamChunksPulled = 0;

    @Controller("/downloads")
    class DownloadsController {
      @Get("stream")
      @Header("X-Download", "streamed")
      fromStream() {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            streamChunksPulled++;
            if (streamChunksPulled === 1) {
              controller.enqueue(new TextEncoder().encode("part-1|"));
            } else if (streamChunksPulled === 2) {
              controller.enqueue(new TextEncoder().encode("part-2"));
            } else {
              controller.close();
            }
          },
        });
        return new StreamableFile(stream, {
          type: "text/plain; charset=utf-8",
          disposition: 'attachment; filename="stream.txt"',
          length: 13,
        });
      }

      @Get("bytes")
      fromBytes() {
        return new StreamableFile(new TextEncoder().encode("hello-bytes"), {
          type: "application/octet-stream",
          disposition: 'inline; filename="data.bin"',
        });
      }

      @Get("bunfile")
      fromBunFile() {
        return new StreamableFile(Bun.file(diskPath), {
          disposition: 'attachment; filename="report.txt"',
        });
      }
    }

    const adapter = new BunHttpAdapter({ logger: false, cors: true });
    await adapter.compileControllers([DownloadsController]);

    // 1. Streaming ReadableStream — verify stream is NOT eagerly buffered before Response is returned
    const streamRes = await adapter.fetch(
      new Request("http://localhost/downloads/stream", {
        headers: { origin: "https://app.test" },
      }),
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(streamRes.headers.get("content-disposition")).toBe(
      'attachment; filename="stream.txt"',
    );
    expect(streamRes.headers.get("content-length")).toBe("13");
    expect(streamRes.headers.get("x-download")).toBe("streamed");
    expect(streamRes.headers.get("access-control-allow-origin")).toBe("*");
    expect(streamChunksPulled).toBeLessThanOrEqual(1);
    expect(await streamRes.text()).toBe("part-1|part-2");
    expect(streamChunksPulled).toBe(3);

    // 2. HEAD on StreamableFile returns headers + empty body
    const headRes = await adapter.fetch(
      new Request("http://localhost/downloads/bytes", { method: "HEAD" }),
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-length")).toBe("11");
    expect(headRes.headers.get("content-disposition")).toBe(
      'inline; filename="data.bin"',
    );
    expect(await headRes.text()).toBe("");

    // 3. Bun.file() wrapped in StreamableFile
    const fileRes = await adapter.fetch(
      new Request("http://localhost/downloads/bunfile"),
    );
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-disposition")).toBe(
      'attachment; filename="report.txt"',
    );
    expect(fileRes.headers.get("content-length")).toBe("23");
    expect(await fileRes.text()).toBe("bun-file-report-content");
  });

  test("useStaticAssets serves files via Bun.file(), respects index/cacheControl/dotfiles/ETag/Range, and blocks traversal, null bytes, symlinks & NTFS ADS", async () => {
    const baseDir = await makeTempDir("bunest-static-");
    const publicDir = join(baseDir, "public");
    const subDir = join(publicDir, "docs");
    await mkdir(subDir, { recursive: true });

    await writeFile(join(baseDir, "secret.txt"), "TOP_SECRET_OUTSIDE");
    await writeFile(join(publicDir, "hello.txt"), "hello static world");
    await writeFile(join(publicDir, ".env"), "SECRET_KEY=123");
    await writeFile(join(subDir, "index.html"), "<h1>Docs Index</h1>");

    let symlinkCreated = false;
    try {
      symlinkSync(join(baseDir, "secret.txt"), join(publicDir, "escape.txt"));
      symlinkCreated = true;
    } catch {
      // Windows without Developer Mode / SeCreateSymbolicLinkPrivilege may refuse symlink creation
    }

    @Controller("/assets")
    class ApiOverrideController {
      @Get("dynamic")
      dynamic() {
        return { source: "controller" };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false, cors: true });
    activeAdapters.push(adapter);
    adapter.useStaticAssets(publicDir, {
      prefix: "/assets",
      index: "index.html",
      cacheControl: "public, max-age=3600",
      dotfiles: "deny",
    });
    await adapter.compileControllers([ApiOverrideController]);

    // Controller route takes precedence over static mount
    const ctrlRes = await adapter.fetch(
      new Request("http://localhost/assets/dynamic"),
    );
    expect(ctrlRes.status).toBe(200);
    expect(await ctrlRes.json()).toEqual({ source: "controller" });

    // Regular static file + cacheControl + ETag + CORS
    const fileRes = await adapter.fetch(
      new Request("http://localhost/assets/hello.txt", {
        headers: { origin: "https://web.test" },
      }),
    );
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(fileRes.headers.get("access-control-allow-origin")).toBe("*");
    expect(fileRes.headers.get("etag")).toBeTruthy();
    expect(await fileRes.text()).toBe("hello static world");

    // ETag 304 Not Modified
    const etag = fileRes.headers.get("etag")!;
    const notModRes = await adapter.fetch(
      new Request("http://localhost/assets/hello.txt", {
        headers: { "if-none-match": etag },
      }),
    );
    expect(notModRes.status).toBe(304);
    expect(await notModRes.text()).toBe("");

    // Byte Range 206 Partial Content
    const rangeRes = await adapter.fetch(
      new Request("http://localhost/assets/hello.txt", {
        headers: { range: "bytes=0-4" },
      }),
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-range")).toBe("bytes 0-4/18");
    expect(await rangeRes.text()).toBe("hello");

    // Directory index.html
    const indexRes = await adapter.fetch(
      new Request("http://localhost/assets/docs/"),
    );
    expect(indexRes.status).toBe(200);
    expect(await indexRes.text()).toBe("<h1>Docs Index</h1>");

    // Dotfiles: "deny" -> 403
    const dotDeny = await adapter.fetch(
      new Request("http://localhost/assets/.env"),
    );
    expect(dotDeny.status).toBe(403);

    // Security attacks: encoded traversal (`%2e%2e%2f`), backslash, null byte, Windows NTFS ADS `:` -> ALL 403!
    const direct403Paths = [
      "/assets/%2e%2e%2fsecret.txt",
      "/assets/docs/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/assets/%2e%2e%5csecret.txt",
      "/assets/hello.txt%00.png",
      "/assets/hello.txt:hiddenstream",
      "/assets/hello.txt%3a$DATA",
      "/assets/C:/Windows/win.ini",
    ];
    for (const p of direct403Paths) {
      const res = await adapter.fetch(new Request(`http://localhost${p}`));
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("TOP_SECRET_OUTSIDE");
    }

    // Direct raw pathname traversal bypassing WHATWG URL dot-segment collapsing -> 403!
    const staticMount = createStaticAssetsMount(publicDir, { prefix: "/assets" });
    for (const rawP of [
      "/assets/../secret.txt",
      "/assets/%2e%2e/secret.txt",
      "/assets/docs/../../secret.txt",
    ]) {
      const rawRes = await tryServeStaticAsset(
        [staticMount],
        rawP,
        new Request("http://localhost/assets/hello.txt"),
      );
      expect(rawRes?.status).toBe(403);
    }

    // URL-collapsed traversal via WHATWG Request also never leaks secret.txt (404)
    const collapsedRes = await adapter.fetch(
      new Request("http://localhost/assets/%2e%2e/secret.txt"),
    );
    expect(collapsedRes.status).toBe(404);
    expect(await collapsedRes.text()).not.toContain("TOP_SECRET_OUTSIDE");

    if (symlinkCreated) {
      const symRes = await adapter.fetch(
        new Request("http://localhost/assets/escape.txt"),
      );
      expect(symRes.status).toBe(403);
    }

    // index: false and dotfiles: "ignore" vs "allow"
    const ignoreAdapter = new BunHttpAdapter({ logger: false });
    ignoreAdapter.useStaticAssets(publicDir, {
      prefix: "/pub",
      index: false,
      dotfiles: "ignore",
    });
    await ignoreAdapter.compileControllers([]);
    expect(
      (await ignoreAdapter.fetch(new Request("http://localhost/pub/docs/")))
        .status,
    ).toBe(404);
    expect(
      (await ignoreAdapter.fetch(new Request("http://localhost/pub/.env")))
        .status,
    ).toBe(404);

    const allowAdapter = new BunHttpAdapter({ logger: false });
    allowAdapter.useStaticAssets(publicDir, {
      prefix: "/pub",
      dotfiles: "allow",
    });
    await allowAdapter.compileControllers([]);
    const dotAllow = await allowAdapter.fetch(
      new Request("http://localhost/pub/.env"),
    );
    expect(dotAllow.status).toBe(200);
    expect(await dotAllow.text()).toBe("SECRET_KEY=123");

    // Live Bun.serve static asset test
    const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
    const liveRes = await fetch(`http://127.0.0.1:${info.port}/assets/hello.txt`);
    expect(liveRes.status).toBe(200);
    expect(await liveRes.text()).toBe("hello static world");
  });

  test("streams multipart uploads directly to diskStorageDir without RAM buffering, enforces maxFileSize/maxFiles, and cleans up temp files on error", async () => {
    const uploadDir = await makeTempDir("bunest-multipart-disk-");

    @Controller("/disk-upload")
    class DiskUploadController {
      @Post("single")
      async uploadSingle(
        @UploadedFile("doc") doc: DiskUploadedFileInfo,
        @Body() fields: Record<string, unknown>,
      ) {
        const streamedText = doc.stream
          ? await new Response(doc.stream()).text()
          : "";
        return {
          fields,
          fieldname: doc.fieldname,
          originalname: doc.originalname,
          mimetype: doc.mimetype,
          size: doc.size,
          ramBufferLen: doc.buffer.byteLength,
          path: doc.path,
          streamedText,
        };
      }

      @Post("multi")
      uploadMulti(@UploadedFiles("files") files: DiskUploadedFileInfo[]) {
        return {
          count: files.length,
          files: files.map((f) => ({
            name: f.originalname,
            size: f.size,
            path: f.path,
            ramLen: f.buffer.byteLength,
          })),
        };
      }
    }

    const adapter = new BunHttpAdapter({
      logger: false,
      multipart: {
        diskStorageDir: uploadDir,
        maxFileSize: 1024,
        maxFiles: 2,
      },
    });
    activeAdapters.push(adapter);
    await adapter.compileControllers([DiskUploadController]);

    // 1. Live Bun.serve upload with fields (incl. prototype-pollution field) + file with adversarial filename
    const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
    const form = new FormData();
    form.append("title", "Quarterly Report");
    form.append("__proto__", "evil");
    form.append(
      "doc",
      new File(["disk-streamed-payload-12345"], "../../evil:ads.txt", {
        type: "text/plain",
      }),
    );

    const res = await fetch(`http://127.0.0.1:${info.port}/disk-upload/single`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      fields: Record<string, unknown>;
      fieldname: string;
      originalname: string;
      size: number;
      ramBufferLen: number;
      path: string;
      streamedText: string;
    };
    expect(json.fields).toEqual({ title: "Quarterly Report" });
    expect(json.fieldname).toBe("doc");
    expect(json.size).toBe(27);
    expect(json.ramBufferLen).toBe(0); // Zero RAM buffered!
    expect(json.streamedText).toBe("disk-streamed-payload-12345");
    expect(json.path).toBeTruthy();
    expect(resolve(json.path).startsWith(resolve(uploadDir))).toBe(true);
    expect(existsSync(json.path)).toBe(true);
    expect(readFileSync(json.path, "utf8")).toBe("disk-streamed-payload-12345");

    // 2. Worst-case 3-byte chunked stream splitting across boundaries & headers + 0-byte empty file!
    const boundary = "----BunestSplitBoundary789";
    const rawMultipart = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="files"; filename="chunked.bin"\r\n`,
      `Content-Type: application/octet-stream\r\n\r\n`,
      `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n`,
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="files"; filename="empty.txt"\r\n`,
      `Content-Type: text/plain\r\n\r\n`,
      `\r\n`,
      `--${boundary}--\r\n`,
    ].join("");
    const rawBytes = new TextEncoder().encode(rawMultipart);
    const tinyChunkStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < rawBytes.byteLength; i += 3) {
          controller.enqueue(rawBytes.subarray(i, Math.min(i + 3, rawBytes.byteLength)));
        }
        controller.close();
      },
    });

    const splitRes = await adapter.fetch(
      new Request("http://localhost/disk-upload/multi", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: tinyChunkStream,
      }),
    );
    expect(splitRes.status).toBe(201);
    const splitJson = (await splitRes.json()) as {
      count: number;
      files: Array<{ name: string; size: number; path: string; ramLen: number }>;
    };
    expect(splitJson.count).toBe(2);
    expect(splitJson.files[0]!.size).toBe(36);
    expect(splitJson.files[0]!.ramLen).toBe(0);
    expect(readFileSync(splitJson.files[0]!.path, "utf8")).toBe(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    );
    expect(splitJson.files[1]!.size).toBe(0);
    expect(existsSync(splitJson.files[1]!.path)).toBe(true);

    // 3. Exceeding maxFileSize -> 413 AND partial temp file cleaned up (no orphan files)
    const countBeforeReject = readdirSync(uploadDir).length;
    const tooBigForm = new FormData();
    tooBigForm.append(
      "doc",
      new File(["x".repeat(2048)], "huge.txt", { type: "text/plain" }),
    );
    const bigRes = await adapter.fetch(
      new Request("http://localhost/disk-upload/single", {
        method: "POST",
        body: tooBigForm,
      }),
    );
    expect(bigRes.status).toBe(413);
    expect(readdirSync(uploadDir).length).toBe(countBeforeReject);

    // 4. Exceeding maxFiles (3 > 2) -> 413 AND earlier uploaded files in same request cleaned up
    const tooManyForm = new FormData();
    tooManyForm.append("files", new File(["a"], "1.txt"));
    tooManyForm.append("files", new File(["b"], "2.txt"));
    tooManyForm.append("files", new File(["c"], "3.txt"));
    const manyRes = await adapter.fetch(
      new Request("http://localhost/disk-upload/multi", {
        method: "POST",
        body: tooManyForm,
      }),
    );
    expect(manyRes.status).toBe(413);
    expect(readdirSync(uploadDir).length).toBe(countBeforeReject);
  });
});

describe("Adapter getBridge() & CompressionMiddleware", () => {
  test("exposes getBridge() cleanly and preserves bridge wrapping", () => {
    const adapter = new BunHttpAdapter({ logger: false });
    const initial = adapter.getBridge();
    expect(initial).toBeInstanceOf(DefaultHttpRuntimeBridge);

    const wrapped: HttpRuntimeBridge = {
      resolveController: (t, rc) => initial.resolveController(t, rc),
      resolveEnhancer: (e, rc, k, c) => initial.resolveEnhancer(e, rc, k, c),
    };
    adapter.setBridge(wrapped);
    expect(adapter.getBridge()).toBe(wrapped);
  });

  test("CompressionMiddleware gzips responses above threshold and sets Vary: Accept-Encoding", async () => {
    @Controller("/compress")
    class CompressController {
      @Get("large")
      large() {
        return { payload: "bunest-compression-".repeat(120) };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.use(new CompressionMiddleware({ threshold: 256 }));
    await adapter.compileControllers([CompressController]);

    const res = await adapter.fetch(
      new Request("http://localhost/compress/large", {
        headers: { "accept-encoding": "gzip" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    const rawCompressed = new Uint8Array(await res.arrayBuffer());
    const decompressed = new TextDecoder().decode(Bun.gunzipSync(rawCompressed));
    expect(JSON.parse(decompressed)).toEqual({
      payload: "bunest-compression-".repeat(120),
    });
  });

  test("Regression #119-1: @RawBody() skips higher-scope pipes while still executing explicit param pipes", async () => {
    const strictBodyObjectPipe: PipeTransform = {
      transform(value: unknown, meta) {
        if (meta.type === "body") {
          if (
            value === null ||
            typeof value !== "object" ||
            value instanceof Uint8Array
          ) {
            throw new Error("Higher-scope pipe MUST NOT run on @RawBody()");
          }
          return { ...(value as Record<string, unknown>), validated: true };
        }
        return value;
      },
    };

    const rawLengthPipe: PipeTransform<Uint8Array | undefined, number> = {
      transform(value) {
        return value ? value.byteLength : -1;
      },
    };

    @Controller("/raw-pipes")
    class RawPipesController {
      @Post("webhook")
      @UsePipes(strictBodyObjectPipe)
      webhook(
        @RawBody() raw: Uint8Array,
        @Body() body: { event: string; validated?: boolean },
      ) {
        return {
          isBytes: raw instanceof Uint8Array,
          rawLen: raw.byteLength,
          body,
        };
      }

      @Post("custom-param-pipe")
      @UsePipes(strictBodyObjectPipe)
      customParamPipe(@RawBody(rawLengthPipe) len: number) {
        return { len };
      }
    }

    const adapter = new BunHttpAdapter({ logger: false, rawBody: true });
    adapter.useGlobalPipes(strictBodyObjectPipe);
    await adapter.compileControllers([RawPipesController]);

    const payload = '{"event":"charge.succeeded"}';
    const r1 = await adapter.fetch(
      new Request("http://localhost/raw-pipes/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
        },
        body: payload,
      }),
    );
    expect(r1.status).toBe(201);
    expect(await r1.json()).toEqual({
      isBytes: true,
      rawLen: payload.length,
      body: { event: "charge.succeeded", validated: true },
    });

    const r2 = await adapter.fetch(
      new Request("http://localhost/raw-pipes/custom-param-pipe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
        },
        body: payload,
      }),
    );
    expect(r2.status).toBe(201);
    expect(await r2.json()).toEqual({ len: payload.length });
  });

  test("Regression #119-2: small JSON bodyLimit does not block larger streaming multipart diskStorageDir uploads when multipart.maxFileSize is set", async () => {
    const uploadDir = await makeTempDir("bunest-multipart-limit-");

    @Controller("/limit-upload")
    class LimitUploadController {
      @Post("file")
      uploadFile(
        @UploadedFile("doc") doc: DiskUploadedFileInfo,
        @Body() fields: Record<string, unknown>,
      ) {
        return {
          size: doc.size,
          path: doc.path,
          fields,
        };
      }

      @Post("json")
      postJson(@Body() body: unknown) {
        return { body };
      }
    }

    const adapter = new BunHttpAdapter({
      logger: false,
      bodyLimit: 256,
      multipart: {
        diskStorageDir: uploadDir,
        maxFileSize: 100_000,
        maxFiles: 2,
      },
    });
    activeAdapters.push(adapter);
    await adapter.compileControllers([LimitUploadController]);
    const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${info.port}`;

    // 1. 2KB file upload with small JSON bodyLimit (256B) + maxFileSize (100KB) -> 201 Created
    const payload2k = "A".repeat(2048);
    const form = new FormData();
    form.append("note", "small-field");
    form.append("doc", new File([payload2k], "report.txt", { type: "text/plain" }));

    const uploadRes = await fetch(`${base}/limit-upload/file`, {
      method: "POST",
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const uploadJson = (await uploadRes.json()) as {
      size: number;
      path: string;
      fields: Record<string, unknown>;
    };
    expect(uploadJson.size).toBe(2048);
    expect(uploadJson.fields).toEqual({ note: "small-field" });
    expect(readFileSync(uploadJson.path, "utf8")).toBe(payload2k);

    // 2. JSON endpoint on same adapter STILL enforces bodyLimit (256B) -> 413
    const bigJsonRes = await fetch(`${base}/limit-upload/json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "Z".repeat(512) }),
    });
    expect(bigJsonRes.status).toBe(413);

    // 3. Oversized multipart text field (> bodyLimit 256B) STILL rejected -> 413
    const bigFieldForm = new FormData();
    bigFieldForm.append("note", "N".repeat(512));
    bigFieldForm.append("doc", new File(["ok"], "tiny.txt"));
    const bigFieldRes = await fetch(`${base}/limit-upload/file`, {
      method: "POST",
      body: bigFieldForm,
    });
    expect(bigFieldRes.status).toBe(413);

    // 4. When multipart.maxFileSize is omitted, falls back to bodyLimit (256B) -> 413 + clean temp dir
    const fallbackDir = await makeTempDir("bunest-multipart-fallback-");
    const fallbackAdapter = new BunHttpAdapter({
      logger: false,
      bodyLimit: 256,
      multipart: { diskStorageDir: fallbackDir },
    });
    await fallbackAdapter.compileControllers([LimitUploadController]);
    const fallbackForm = new FormData();
    fallbackForm.append("doc", new File([payload2k], "too-big.txt"));
    const fallbackRes = await fallbackAdapter.fetch(
      new Request("http://localhost/limit-upload/file", {
        method: "POST",
        body: fallbackForm,
      }),
    );
    expect(fallbackRes.status).toBe(413);
    expect(readdirSync(fallbackDir)).toHaveLength(0);
  });

  test("Regression #119-3: CompressionMiddleware skips 206 Partial Content and Content-Range responses", async () => {
    const chunkBody = "R".repeat(2000);

    @Controller("/range-compress")
    class RangeCompressController {
      @Get("partial")
      partial() {
        return new Response(chunkBody, {
          status: 206,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-range": "bytes 0-1999/10000",
          },
        });
      }

      @Get("with-range-header")
      withRangeHeader() {
        return new Response(chunkBody, {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-range": "bytes 0-1999/10000",
          },
        });
      }
    }

    const adapter = new BunHttpAdapter({ logger: false });
    adapter.use(new CompressionMiddleware({ threshold: 256 }));
    await adapter.compileControllers([RangeCompressController]);

    const r206 = await adapter.fetch(
      new Request("http://localhost/range-compress/partial", {
        headers: { "accept-encoding": "gzip, deflate" },
      }),
    );
    expect(r206.status).toBe(206);
    expect(r206.headers.get("content-encoding")).toBeNull();
    expect(r206.headers.get("content-range")).toBe("bytes 0-1999/10000");
    expect(await r206.text()).toBe(chunkBody);

    const rContentRange = await adapter.fetch(
      new Request("http://localhost/range-compress/with-range-header", {
        headers: { "accept-encoding": "gzip" },
      }),
    );
    expect(rContentRange.status).toBe(200);
    expect(rContentRange.headers.get("content-encoding")).toBeNull();
    expect(await rContentRange.text()).toBe(chunkBody);
  });
});
