import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  Cookies,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Res,
  Sse,
  UnauthorizedException,
  UploadedFile,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  type ArgumentsHost,
  type BunestInterceptor,
  type BunestMiddleware,
  type BunestModule,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type MiddlewareConsumer,
  type NextFunction,
  type PipeTransform,
  type ResponseContext,
  type SseMessageEvent,
  type UploadedFileInfo,
  type ValidationErrorResponse,
} from "@bunest/core";
import { ClassSerializerInterceptor, ValidationPipe } from "@bunest/core";
import { Exclude, Expose } from "../../../validation/src/transformer";
import { IsEmail, IsString, MinLength } from "../../../validation/src/validator";
import {
  Test,
  TestClient,
  createNodeHttpServer,
  parseSseJson,
  readSseEvents,
  request,
} from "../../src";

class SignupDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(4)
  password!: string;
}

class SignupEntity {
  id!: string;
  email!: string;

  @Exclude()
  password!: string;

  @Expose()
  get summary(): string {
    return `user:${this.email}`;
  }

  constructor(partial: Partial<SignupEntity>) {
    Object.assign(this, partial);
  }
}

describe("E2E: Pipeline Order, Validation, Multipart, SSE, Cookie Agent, Supertest Assertions & Node HTTP Bridge", () => {
  it("executes Middleware -> Guard -> Interceptor(before) -> Pipe -> Handler -> Interceptor(after) -> Filter in exact order", async () => {
    const order: string[] = [];

    @Injectable()
    class ClassMw implements BunestMiddleware {
      use(_req: Request, _res: ResponseContext, next: NextFunction) {
        order.push("class-mw");
        return next();
      }
    }

    @Injectable()
    class TraceGuard implements CanActivate {
      canActivate() {
        order.push("guard");
        return true;
      }
    }

    @Injectable()
    class TraceInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        order.push("interceptor:before");
        const out = await next.handle();
        order.push("interceptor:after");
        return { wrapped: out };
      }
    }

    @Injectable()
    class TracePipe implements PipeTransform<string, string> {
      transform(v: string) {
        order.push("pipe");
        return v.toUpperCase();
      }
    }

    class PipelineError extends Error {}

    @Catch(PipelineError)
    @Injectable()
    class TraceFilter implements ExceptionFilter<PipelineError> {
      catch(err: PipelineError, _host: ArgumentsHost) {
        order.push("filter");
        return Response.json({ caught: err.message }, { status: 418 });
      }
    }

    @Controller("/pipe-order")
    @UseGuards(TraceGuard)
    @UseInterceptors(TraceInterceptor)
    @UseFilters(TraceFilter)
    class OrderController {
      @Get("ok/:word")
      ok(@Param("word", TracePipe) word: string) {
        order.push("handler");
        return { word };
      }

      @Get("fail")
      fail(): never {
        order.push("handler-throw");
        throw new PipelineError("boom");
      }

      @Get("excluded")
      excluded() {
        order.push("handler-excluded");
        return { excluded: true };
      }
    }

    @Module({
      controllers: [OrderController],
      providers: [ClassMw],
    })
    class OrderModule implements BunestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(ClassMw)
          .exclude("/pipe-order/excluded")
          .forRoutes(OrderController);
      }
    }

    const mod = await Test.createTestingModule({
      imports: [OrderModule],
    }).compile();

    const app = mod.createNestApplication();
    app.use((_req, _res, next) => {
      order.push("global-mw");
      return next();
    });
    await app.init();

    try {
      await request(app)
        .get("/pipe-order/ok/bun")
        .expect(200, { wrapped: { word: "BUN" } });

      expect(order).toEqual([
        "global-mw",
        "class-mw",
        "guard",
        "interceptor:before",
        "pipe",
        "handler",
        "interceptor:after",
      ]);

      order.length = 0;
      await request(app)
        .get("/pipe-order/fail")
        .expect(418, { caught: "boom" });

      expect(order).toEqual([
        "global-mw",
        "class-mw",
        "guard",
        "interceptor:before",
        "handler-throw",
        "filter",
      ]);

      order.length = 0;
      await request(app)
        .get("/pipe-order/excluded")
        .expect(200, { wrapped: { excluded: true } });

      // ClassMw excluded, global middleware still runs
      expect(order).not.toContain("class-mw");
      expect(order[0]).toBe("global-mw");
    } finally {
      await mod.close();
    }
  });

  it("validates DTOs with ValidationPipe, serializes with ClassSerializerInterceptor, and exercises Supertest-style assertions", async () => {
    let calls = 0;

    @Controller("/auth-val")
    @UseInterceptors(ClassSerializerInterceptor)
    class AuthValController {
      @Post("signup")
      signup(@Body() dto: SignupDto): SignupEntity {
        calls += 1;
        return new SignupEntity({
          id: "u_1",
          email: dto.email,
          password: dto.password,
        });
      }

      @Get("whoami")
      whoami(
        @Headers("authorization") auth?: string,
        @Query("mode") mode?: string,
      ) {
        return { auth, mode };
      }

      @Post("form")
      form(@Body() body: Record<string, unknown>) {
        return { received: body };
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [AuthValController],
    }).compile();

    const app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    try {
      // Valid signup -> 201 + @Exclude() password stripped + fluent .expect() variants
      await request(app)
        .post("/auth-val/signup")
        .send({ email: "dev@bunest.dev", password: "secret" })
        .expect(201)
        .expect("content-type", /application\/json/)
        .expect({
          id: "u_1",
          email: "dev@bunest.dev",
          summary: "user:dev@bunest.dev",
        })
        .expect((res) => {
          expect("password" in res.body).toBe(false);
        });
      expect(calls).toBe(1);

      // Invalid signup -> 400 + handler skipped
      await request(app)
        .post("/auth-val/signup")
        .send({ email: "bad", password: "1", extra: true })
        .expect(400)
        .expect((res) => {
          const err = res.body as ValidationErrorResponse;
          expect(err.message).toBe("Validation failed");
          expect(err.details.map((d) => d.field).sort()).toEqual([
            "email",
            "extra",
            "password",
          ]);
        });
      expect(calls).toBe(1);

      // .auth() bearer & basic, .query(), .type("form")
      await request(app)
        .get("/auth-val/whoami")
        .auth("tok_xyz", { type: "bearer" })
        .query({ mode: "strict" })
        .expect(200, { auth: "Bearer tok_xyz", mode: "strict" });

      await request(app)
        .get("/auth-val/whoami")
        .auth("alice", "pw")
        .expect(200)
        .expect((res) => {
          expect(res.body.auth).toBe(`Basic ${btoa("alice:pw")}`);
        });

      await request(app)
        .post("/auth-val/form")
        .type("form")
        .send({ a: "1", b: "two" })
        .expect(201, { received: { a: "1", b: "two" } });

      // Failing expectation throws a descriptive error
      await expect(
        Promise.resolve(request(app).get("/auth-val/whoami").expect(404)),
      ).rejects.toThrow(/expected status 404, got 200/);
    } finally {
      await mod.close();
    }
  });

  it("uploads multipart fields and files via request(app).post().field().attach()", async () => {
    @Controller("/uploads")
    class UploadController {
      @Post("single")
      single(
        @Body() fields: Record<string, unknown>,
        @UploadedFile("doc") file: UploadedFileInfo,
      ) {
        return {
          title: fields.title,
          tags: fields.tags,
          file: {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            text: new TextDecoder().decode(file.buffer),
          },
        };
      }

      @Post("multi")
      multi(@UploadedFiles("files") files: UploadedFileInfo[]) {
        return {
          count: files.length,
          names: files.map((f) => f.originalname),
          contents: files.map((f) => new TextDecoder().decode(f.buffer)),
        };
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [UploadController],
    }).compile();

    const app = mod.createNestApplication();
    await app.init();

    try {
      const payload = new TextEncoder().encode("hello-multipart");
      await request(app)
        .post("/uploads/single")
        .field("title", "Quarterly Report")
        .field("tags", ["q1", "finance"])
        .attach("doc", payload, "report.txt", "text/plain")
        .expect(201)
        .expect((res) => {
          expect(res.body.title).toBe("Quarterly Report");
          expect(res.body.file.fieldname).toBe("doc");
          expect(res.body.file.originalname).toBe("report.txt");
          expect(res.body.file.text).toBe("hello-multipart");
          expect(res.body.file.size).toBe(15);
        });

      await request(app)
        .post("/uploads/multi")
        .attach("files", "alpha", "a.txt", "text/plain")
        .attach("files", "beta", "b.txt", "text/plain")
        .expect(201, {
          count: 2,
          names: ["a.txt", "b.txt"],
          contents: ["alpha", "beta"],
        });
    } finally {
      await mod.close();
    }
  });

  it("streams SSE events via readSseEvents() both in-memory and over live listen(0) with clean cancellation", async () => {
    let infiniteGeneratorCleanedUp = 0;

    @Controller("/events")
    class EventsController {
      @Sse("finite")
      async *finite(): AsyncGenerator<SseMessageEvent> {
        yield { id: "1", type: "tick", data: { n: 1 }, retry: 1500 };
        yield { id: "2", type: "tick", data: { n: 2 } };
        yield { id: "3", type: "done", data: "finished" };
      }

      @Sse("infinite")
      async *infinite(): AsyncGenerator<SseMessageEvent> {
        let i = 0;
        try {
          while (true) {
            i += 1;
            yield { id: String(i), type: "pulse", data: { seq: i } };
            await Bun.sleep(5);
          }
        } finally {
          infiniteGeneratorCleanedUp += 1;
        }
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [EventsController],
    }).compile();

    const app = mod.createNestApplication();
    const info = await app.listen(0);

    try {
      // 1. In-memory finite SSE
      const memClient = TestClient.fromApp(app);
      const memFiniteRes = await memClient.get("/events/finite");
      memFiniteRes
        .expectStatus(200)
        .expectHeader("content-type", /text\/event-stream/);
      const memEvents = await readSseEvents(memFiniteRes);
      expect(memEvents).toHaveLength(3);
      expect(memEvents[0]).toEqual({
        id: "1",
        event: "tick",
        retry: 1500,
        data: JSON.stringify({ n: 1 }),
      });
      expect(parseSseJson<{ n: number }>(memEvents[1]!)).toEqual({ n: 2 });
      expect(memEvents[2]).toEqual({
        id: "3",
        event: "done",
        data: "finished",
      });

      // 2. In-memory infinite SSE stopped at maxEvents -> generator finally runs
      const memInfRes = await memClient.get("/events/infinite");
      const firstTwo = await readSseEvents(memInfRes, { maxEvents: 2 });
      expect(firstTwo).toHaveLength(2);
      expect(parseSseJson<{ seq: number }>(firstTwo[0]!)).toEqual({ seq: 1 });
      expect(parseSseJson<{ seq: number }>(firstTwo[1]!)).toEqual({ seq: 2 });
      await Bun.sleep(25);
      expect(infiniteGeneratorCleanedUp).toBeGreaterThanOrEqual(1);

      // 3. Live listen(0) SSE with maxEvents & AbortController
      const liveClient = TestClient.fromUrl(info.url);
      const liveFiniteRes = await liveClient.get("/events/finite");
      const liveEvents = await readSseEvents(liveFiniteRes);
      expect(liveEvents).toHaveLength(3);
      expect(parseSseJson<{ n: number }>(liveEvents[0]!)).toEqual({ n: 1 });

      const ac = new AbortController();
      const liveInfRes = await liveClient.get("/events/infinite");
      const liveLimited = await readSseEvents(liveInfRes, {
        maxEvents: 2,
        signal: ac.signal,
        timeoutMs: 2000,
      });
      expect(liveLimited).toHaveLength(2);

      // 4. Pre-aborted AbortSignal returns [] and unlocks the response body stream
      const preAborted = new AbortController();
      preAborted.abort();
      const abortedRes = await memClient.get("/events/finite");
      const abortedEvents = await readSseEvents(abortedRes, {
        signal: preAborted.signal,
      });
      expect(abortedEvents).toEqual([]);
      expect(abortedRes.raw.body?.locked).toBe(false);
    } finally {
      await mod.close();
    }
  });

  it("persists cookies across requests with request.agent(app) and client.agent() (login, path scope, logout)", async () => {
    @Controller("/session")
    class SessionController {
      @Post("login")
      login(@Body() body: { user: string }, @Res() res: ResponseContext) {
        res.cookie("sid", `sess_${body.user}`, { httpOnly: true, path: "/" });
        res.cookie("admin_only", "secret", { path: "/session/admin" });
        return { loggedIn: body.user };
      }

      @Get("me")
      me(
        @Cookies("sid") sid?: string,
        @Cookies("admin_only") adminOnly?: string,
      ) {
        if (!sid) {
          throw new UnauthorizedException("Not logged in");
        }
        return { sid, adminOnly: adminOnly ?? null };
      }

      @Get("admin")
      admin(
        @Cookies("sid") sid?: string,
        @Cookies("admin_only") adminOnly?: string,
      ) {
        return { sid: sid ?? null, adminOnly: adminOnly ?? null };
      }

      @Post("logout")
      logout(@Res() res: ResponseContext) {
        res.cookie("sid", "", { path: "/", maxAge: 0 });
        return { loggedOut: true };
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [SessionController],
    }).compile();

    const app = mod.createNestApplication();
    await app.init();

    try {
      // 1. Supertest-style stateful request.agent(app)
      const stAgent = request.agent(app);
      await stAgent.get("/session/me").expect(401);

      await stAgent
        .post("/session/login")
        .send({ user: "alice" })
        .expect(201, { loggedIn: "alice" });

      expect(stAgent.getCookies()).toEqual({
        sid: "sess_alice",
        admin_only: "secret",
      });

      // Path-scoped admin_only cookie NOT sent to /session/me, IS sent to /session/admin
      await stAgent
        .get("/session/me")
        .expect(200, { sid: "sess_alice", adminOnly: null });

      await stAgent
        .get("/session/admin")
        .expect(200, { sid: "sess_alice", adminOnly: "secret" });

      // Logout clears sid via Max-Age=0
      await stAgent.post("/session/logout").expect(201, { loggedOut: true });
      await stAgent.get("/session/me").expect(401);

      // 2. TestClient stateful client.agent()
      const clientAgent = TestClient.fromApp(app).agent();
      (await clientAgent.get("/session/me")).expectStatus(401);
      (await clientAgent.post("/session/login", { json: { user: "bob" } }))
        .expectStatus(201)
        .expectCookie("sid", "sess_bob");

      const meRes = await clientAgent.get("/session/me");
      meRes.expectStatus(200);
      await meRes.expectJson({ sid: "sess_bob", adminOnly: null });

      clientAgent.clearCookies();
      (await clientAgent.get("/session/me")).expectStatus(401);
    } finally {
      await mod.close();
    }
  });

  it("isolates path-scoped cookies across in-memory redirects and captures 3xx Set-Cookie on live TestClient.agent(url)", async () => {
    @Controller()
    class RedirectCookieController {
      @Get("/admin/set")
      setAdmin(@Res() res: ResponseContext) {
        res.cookie("admin_secret", "123", { path: "/admin" });
        return { set: true };
      }

      @Get("/admin/go")
      adminGo(@Res() res: ResponseContext) {
        res.status(302).header("location", "/public");
      }

      @Get("/public")
      pub(
        @Cookies("admin_secret") adminSecret?: string,
        @Cookies("hop_sid") hopSid?: string,
      ) {
        return {
          adminSecret: adminSecret ?? null,
          hopSid: hopSid ?? null,
        };
      }

      @Get("/redirect-sets-cookie")
      redirectSetsCookie(@Res() res: ResponseContext) {
        res.cookie("hop_sid", "from302", { path: "/" });
        res.status(302).header("location", "/public");
      }

      @Post("/redirect-307")
      redirect307(@Res() res: ResponseContext) {
        res.status(307).header("location", "/echo-307");
      }

      @Post("/echo-307")
      echo307(@Body() body: { kept: boolean }) {
        return { kept: body.kept };
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [RedirectCookieController],
    }).compile();

    const app = mod.createNestApplication();
    const info = await app.listen(0);

    try {
      // 1. In-memory TestAgent: Path=/admin cookie must NOT leak onto redirected /public
      const memAgent = TestClient.fromApp(app).agent();
      (await memAgent.get("/admin/set")).expectStatus(200);
      const pubRes = await memAgent.get("/admin/go", { redirect: "follow" });
      pubRes.expectStatus(200);
      expect(await pubRes.json()).toEqual({ adminSecret: null, hopSid: null });

      // 307 preserves POST JSON body
      const r307 = await memAgent.post("/redirect-307", {
        json: { kept: true },
        redirect: "follow",
      });
      r307.expectStatus(201);
      expect(await r307.json()).toEqual({ kept: true });

      // 2. Live TestClient.agent(info.url): captures Set-Cookie on 302 hop when redirect: "follow"
      const liveAgent = TestClient.agent(info.url);
      const liveFollowed = await liveAgent.get("/redirect-sets-cookie", {
        redirect: "follow",
      });
      liveFollowed.expectStatus(200);
      expect(await liveFollowed.json()).toEqual({
        adminSecret: null,
        hopSid: "from302",
      });
      expect(liveAgent.getCookies()).toEqual({ hop_sid: "from302" });
    } finally {
      await mod.close();
    }
  });

  it("bridges live loopback Node http.Server requests via createNodeHttpServer(app) (JSON, binary, multi Set-Cookie)", async () => {
    @Controller("/bridge")
    class BridgeController {
      @Get("cookies")
      cookies(@Res() res: ResponseContext) {
        res.cookie("c1", "v1", { path: "/" });
        res.cookie("c2", "v2", { path: "/", httpOnly: true });
        res.header("X-Bridge", "node-ok");
        return { bridged: true };
      }

      @Post("echo")
      echo(@Body() body: { msg: string }) {
        return { echoed: body.msg };
      }

      @Get("bytes")
      bytes() {
        return new Uint8Array([1, 2, 3, 4, 5]);
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [BridgeController],
    }).compile();

    const app = mod.createNestApplication();
    await app.init();

    const nodeServer = createNodeHttpServer(app);
    await new Promise<void>((resolve) => {
      nodeServer.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const addr = nodeServer.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // GET with multi Set-Cookie
      const cookieRes = await fetch(`${baseUrl}/bridge/cookies`);
      expect(cookieRes.status).toBe(200);
      expect(cookieRes.headers.get("x-bridge")).toBe("node-ok");
      expect(cookieRes.headers.getSetCookie()).toHaveLength(2);
      expect(await cookieRes.json()).toEqual({ bridged: true });

      // POST JSON
      const echoRes = await fetch(`${baseUrl}/bridge/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msg: "via-node-http" }),
      });
      expect(echoRes.status).toBe(201);
      expect(await echoRes.json()).toEqual({ echoed: "via-node-http" });

      // Binary payload
      const binRes = await fetch(`${baseUrl}/bridge/bytes`);
      expect(binRes.status).toBe(200);
      expect(Array.from(new Uint8Array(await binRes.arrayBuffer()))).toEqual([
        1, 2, 3, 4, 5,
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((err) => (err ? reject(err) : resolve()));
      });
      await mod.close();
    }
  });
});
