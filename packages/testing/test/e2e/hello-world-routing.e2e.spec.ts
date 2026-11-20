import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  All,
  BadRequestException,
  Body,
  Controller,
  Cookies,
  Delete,
  Get,
  Head,
  Header,
  Headers,
  HostParam,
  HttpCode,
  Module,
  Options,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Redirect,
  Res,
  type ResponseContext,
} from "@bunest/common";
import { Test, TestClient, request } from "../../src";

@Controller("/routing")
class RoutingController {
  @Get("hello")
  @Header("X-Greeting", "bunest")
  hello() {
    return "Hello world!";
  }

  @Post("items")
  @HttpCode(201)
  createItem(@Body() body: { name: string }) {
    return { created: body.name };
  }

  @Put("items/:id")
  putItem(@Param("id") id: string, @Body() body: { name: string }) {
    return { method: "PUT", id, name: body.name };
  }

  @Patch("items/:id")
  patchItem(@Param("id") id: string, @Body() body: { name: string }) {
    return { method: "PATCH", id, name: body.name };
  }

  @Delete("items/:id")
  @HttpCode(204)
  deleteItem(@Param("id") _id: string) {}

  @Head("ping")
  headPing(@Res() res: ResponseContext) {
    res.header("X-Pong", "yes");
  }

  @Options("meta")
  optionsMeta(@Res() res: ResponseContext) {
    res.header("X-Allow", "GET,POST");
    return { methods: ["GET", "POST"] };
  }

  @All("any")
  anyMethod(@Headers("x-via") via?: string) {
    return { via: via ?? "direct" };
  }

  @Get("optional/:id?")
  optionalParam(@Param("id") id?: string) {
    return { id: id ?? "default" };
  }

  @Get("numeric/:id(\\d+)")
  numericParam(@Param("id") id: string) {
    return { numericId: Number(id) };
  }

  @Get("assets/*")
  wildcardTail(@Param("*") rest?: string, @Param("0") zero?: string) {
    return { wildcard: rest ?? zero ?? "matched" };
  }

  @Get("inspect")
  inspect(
    @Query("q") q?: string,
    @Query("tag") tag?: string | string[],
    @Headers("x-trace") trace?: string,
    @Cookies("pref") pref?: string,
  ) {
    return { q, tag, trace, pref };
  }

  @Get("old-path")
  @Redirect("/routing/new-path", 302)
  redirectRoute() {}

  @Get("new-path")
  newPath() {
    return { arrived: true };
  }

  @Get("binary")
  binary() {
    return new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  }

  @Get("stream")
  stream(@Res() res: ResponseContext) {
    res.header("content-type", "text/plain; charset=utf-8");
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("chunk-1:"));
        controller.enqueue(encoder.encode("chunk-2"));
        controller.close();
      },
    });
  }

  @Get("bad")
  bad(): never {
    throw new BadRequestException("invalid-input");
  }
}

@Controller({ path: "/tenant", host: ":tenant.example.test" })
class TenantHostController {
  @Get("info")
  info(@HostParam("tenant") tenant: string) {
    return { tenant };
  }
}

@Controller("/health")
class HealthController {
  @Get()
  check() {
    return { status: "ok" };
  }
}

@Module({
  controllers: [RoutingController, TenantHostController, HealthController],
})
class RoutingAppModule {}

describe("E2E: Hello World, Routing, Redirect Parity, Global Prefix, CORS, app.inject(), Binary & Streaming", () => {
  it("exercises HTTP verbs, params (required/optional/regex/wildcard), query, headers, cookies, host routing, and binary/streaming", async () => {
    const mod = await Test.createTestingModule({
      imports: [RoutingAppModule],
    }).compile();

    const app = mod.createNestApplication();
    await app.init();

    try {
      // Verbs & @Header / @HttpCode
      await request(app)
        .get("/routing/hello")
        .expect(200, "Hello world!")
        .expect("x-greeting", "bunest");

      await request(app)
        .post("/routing/items")
        .send({ name: "Widget" })
        .expect(201, { created: "Widget" });

      await request(app)
        .put("/routing/items/42")
        .send({ name: "Updated" })
        .expect(200, { method: "PUT", id: "42", name: "Updated" });

      await request(app)
        .patch("/routing/items/42")
        .send({ name: "Patched" })
        .expect(200, { method: "PATCH", id: "42", name: "Patched" });

      await request(app).delete("/routing/items/42").expect(204);

      await request(app)
        .head("/routing/ping")
        .expect(200)
        .expect("x-pong", "yes");

      await request(app)
        .options("/routing/meta")
        .expect(200, { methods: ["GET", "POST"] })
        .expect("x-allow", "GET,POST");

      await request(app)
        .post("/routing/any")
        .set("x-via", "all-test")
        .expect(201, { via: "all-test" });

      // Optional, regex, wildcard params
      await request(app)
        .get("/routing/optional")
        .expect(200, { id: "default" });
      await request(app)
        .get("/routing/optional/abc")
        .expect(200, { id: "abc" });

      await request(app)
        .get("/routing/numeric/123")
        .expect(200, { numericId: 123 });
      await request(app).get("/routing/numeric/not-a-number").expect(404);

      await request(app)
        .get("/routing/assets/img/logo.png")
        .expect(200)
        .expect((res) => {
          expect(typeof res.body.wildcard).toBe("string");
        });

      // Query, headers, cookies
      await request(app)
        .get("/routing/inspect")
        .query({ q: "bun", tag: ["fast", "native"] })
        .set("x-trace", "tr-9")
        .cookies({ pref: "compact" })
        .expect(200, {
          q: "bun",
          tag: ["fast", "native"],
          trace: "tr-9",
          pref: "compact",
        });

      // Host routing
      await request(app)
        .get("/tenant/info")
        .set("Host", "acme.example.test")
        .expect(200, { tenant: "acme" });

      await request(app)
        .get("/tenant/info")
        .set("Host", "other.domain.invalid")
        .expect(404);

      // Binary & ReadableStream responses
      const binRes = await request(app).get("/routing/binary").expect(200);
      expect(Array.from(binRes.bytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);

      await request(app)
        .get("/routing/stream")
        .expect(200, "chunk-1:chunk-2")
        .expect("content-type", /text\/plain/);
    } finally {
      await mod.close();
    }
  });

  it("asserts IDENTICAL @Redirect 302 + Location behavior between in-memory (fromApp/request(app)) and live listen(0) (fromUrl/request(url))", async () => {
    const mod = await Test.createTestingModule({
      imports: [RoutingAppModule],
    }).compile();

    const app = mod.createNestApplication();
    const info = await app.listen(0);

    try {
      const memClient = TestClient.fromApp(app);
      const liveClient = TestClient.fromUrl(info.url);

      // 1. TestClient default manual redirect parity
      const memRes = await memClient.get("/routing/old-path");
      const liveRes = await liveClient.get("/routing/old-path");

      memRes.expectStatus(302).expectHeader("location", "/routing/new-path");
      liveRes.expectStatus(302).expectHeader("location", "/routing/new-path");
      expect(liveRes.status).toBe(memRes.status);
      expect(liveRes.header("location")).toBe(memRes.header("location"));

      // 2. TestClient explicit redirect: "follow" parity
      const memFollowed = await memClient.get("/routing/old-path", {
        redirect: "follow",
      });
      const liveFollowed = await liveClient.get("/routing/old-path", {
        redirect: "follow",
      });
      memFollowed.expectStatus(200);
      liveFollowed.expectStatus(200);
      expect(await memFollowed.json()).toEqual({ arrived: true });
      expect(await liveFollowed.json()).toEqual({ arrived: true });

      // 3. Supertest-style request(app) vs request(info.url) vs request(app.getHttpServer()!)
      await request(app)
        .get("/routing/old-path")
        .expect(302)
        .expect("location", "/routing/new-path");

      await request(info.url)
        .get("/routing/old-path")
        .expect(302)
        .expect("location", "/routing/new-path");

      const server = app.getHttpServer();
      expect(server).toBeDefined();
      await request(server!)
        .get("/routing/old-path")
        .expect(302)
        .expect("location", "/routing/new-path");

      // 4. Supertest-style .redirects(1) follows both in-memory and live
      await request(app)
        .get("/routing/old-path")
        .redirects(1)
        .expect(200, { arrived: true });
      await request(info.url)
        .get("/routing/old-path")
        .redirects(1)
        .expect(200, { arrived: true });

      // 5. request(TestClient.fromUrl(info.url)) preserves baseUrl & SupertestAgent.unset() handles mixed-case defaultHeaders
      await request(liveClient)
        .get("/routing/hello")
        .expect(200, "Hello world!");

      await request(app, { defaultHeaders: { "X-Trace": "stale-default" } })
        .unset("X-Trace")
        .get("/routing/inspect")
        .expect(200)
        .expect((res) => {
          expect(res.body.trace).toBeUndefined();
        });

      // 6. Binary & streaming also match over live TCP
      const liveBin = await liveClient.get("/routing/binary");
      liveBin.expectStatus(200);
      expect(Array.from(await liveBin.bytes())).toEqual([0xde, 0xad, 0xbe, 0xef]);

      const liveStream = await liveClient.get("/routing/stream");
      liveStream.expectStatus(200);
      expect(await liveStream.text()).toBe("chunk-1:chunk-2");
    } finally {
      await mod.close();
    }
  });

  it("supports setGlobalPrefix + exclude and CORS (preflight, success, and error paths)", async () => {
    const mod = await Test.createTestingModule({
      imports: [RoutingAppModule],
    }).compile();

    const app = mod.createNestApplication();
    app.setGlobalPrefix("/api", { exclude: ["/health"] });
    app.enableCors({
      origin: "https://web.example.test",
      credentials: true,
    });
    await app.init();

    try {
      // Excluded route stays at /health
      await request(app).get("/health").expect(200, { status: "ok" });
      await request(app).get("/api/health").expect(404);

      // Prefixed route lives under /api/routing/hello
      await request(app)
        .get("/api/routing/hello")
        .set("Origin", "https://web.example.test")
        .expect(200, "Hello world!")
        .expect("access-control-allow-origin", "https://web.example.test")
        .expect("access-control-allow-credentials", "true");

      // CORS Preflight OPTIONS
      await request(app)
        .options("/api/routing/items")
        .set("Origin", "https://web.example.test")
        .set("Access-Control-Request-Method", "POST")
        .expect(204)
        .expect("access-control-allow-origin", "https://web.example.test");

      // CORS headers preserved on 400 error path & 404 path
      await request(app)
        .get("/api/routing/bad")
        .set("Origin", "https://web.example.test")
        .expect(400)
        .expect("access-control-allow-origin", "https://web.example.test");

      await request(app)
        .get("/api/does-not-exist")
        .set("Origin", "https://web.example.test")
        .expect(404)
        .expect("access-control-allow-origin", "https://web.example.test");
    } finally {
      await mod.close();
    }
  });

  it("supports zero-socket NestJS-style app.inject() (string shorthand & options object)", async () => {
    const mod = await Test.createTestingModule({
      imports: [RoutingAppModule],
    }).compile();

    const app = mod.createNestApplication();
    await app.init();

    try {
      // Never bound a socket
      expect(app.getHttpServer()).toBeUndefined();

      // String shorthand
      const helloRes = await app.inject("/routing/hello");
      expect(helloRes.statusCode).toBe(200);
      expect(helloRes.body).toBe("Hello world!");
      expect(helloRes.headers["x-greeting"]).toBe("bunest");

      // Options object with query, headers, cookies
      const inspectRes = await app.inject({
        method: "GET",
        url: "/routing/inspect",
        query: { q: "inject", tag: ["a", "b"] },
        headers: { "x-trace": "inj-1" },
        cookies: { pref: "dark" },
      });
      expect(inspectRes.statusCode).toBe(200);
      expect(inspectRes.json()).toEqual({
        q: "inject",
        tag: ["a", "b"],
        trace: "inj-1",
        pref: "dark",
      });

      // JSON payload POST
      const postRes = await app.inject({
        method: "POST",
        url: "/routing/items",
        payload: { name: "Injected" },
      });
      expect(postRes.statusCode).toBe(201);
      expect(postRes.json()).toEqual({ created: "Injected" });

      // Binary rawPayload & 404 error
      const binRes = await app.inject("/routing/binary");
      expect(Array.from(binRes.rawPayload)).toEqual([0xde, 0xad, 0xbe, 0xef]);

      const missingRes = await app.inject("/routing/missing");
      expect(missingRes.statusCode).toBe(404);
    } finally {
      await mod.close();
    }
  });
});
