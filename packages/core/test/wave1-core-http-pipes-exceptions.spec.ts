import { describe, expect, it } from "bun:test";
import {
  BaseExceptionFilter,
  BODY_SANITIZED_SYMBOL,
  BunestFactory,
  Controller,
  DefaultExceptionFilter,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  LockedException,
  Module,
  ParseFloatPipe,
  ParseIntPipe,
  PayloadTooLargeException,
  PaymentRequiredException,
  RequestContext,
  Res,
  StandardSchemaValidationPipe,
  StreamableFile,
  ValidationPipe,
  type ArgumentsHost,
  type DefaultHttpRequest,
  type DefaultHttpResponse,
  type HttpAdapterTypes,
  type HttpArgumentsHost,
  type LoggerService,
  type ModuleMetadata,
  type ResponseContext,
  type ValidationError,
} from "../src/index";
import { parseRequestBody } from "../src/http/parsers/body-parser";
import { formatErrorForInternalLog } from "../src/http/pipeline/exception-handler";
import { serializeResponseMaybeAsync } from "../src/http/pipeline/response-serializer";

function createMockArgumentsHost(res?: ResponseContext): ArgumentsHost {
  const req = new Request("http://localhost/test");
  const httpHost: HttpArgumentsHost = {
    getRequest: <T = DefaultHttpRequest>() => req as unknown as T,
    getResponse: <T = DefaultHttpResponse>() => res as unknown as T,
    getNext: <T = unknown>() => undefined as unknown as T,
  };
  return {
    getArgs: <T extends Array<any> = any[]>() => [req, res] as unknown as T,
    getArgByIndex: <T = any>(idx: number) => (idx === 0 ? req : res) as T,
    switchToHttp: () => httpHost,
    switchToRpc: () => ({
      getData: <T = any>() => undefined as unknown as T,
      getContext: <T = any>() => undefined as unknown as T,
    }),
    switchToWs: () => ({
      getData: <T = any>() => undefined as unknown as T,
      getClient: <T = any>() => undefined as unknown as T,
      getPattern: () => "",
    }),
    getType: <TContext extends string = "http">() => "http" as TContext,
  };
}

describe("Wave 1 Core HTTP, Pipes, Exceptions & Types", () => {
  describe("1. Prototype-pollution stripping on untyped/schemaless early-return paths", () => {
    it("strips __proto__, prototype, and constructor on untyped ValidationPipe", async () => {
      const pipe = new ValidationPipe();
      const payload = JSON.parse(
        '{"name":"alice","__proto__":{"admin":true},"constructor":{"polluted":1},"nested":{"prototype":{"x":1},"ok":true},"items":[{"__proto__":{"bad":true},"id":1}]}',
      );

      const result = (await pipe.transform(payload, {
        type: "body",
      })) as Record<string, unknown>;

      expect(Object.hasOwn(result, "__proto__")).toBe(false);
      expect(Object.hasOwn(result, "constructor")).toBe(false);
      expect(result.name).toBe("alice");
      expect(
        Object.hasOwn(result.nested as Record<string, unknown>, "prototype"),
      ).toBe(false);
      expect((result.nested as Record<string, unknown>).ok).toBe(true);
      expect(
        Object.hasOwn(
          (result.items as Record<string, unknown>[])[0]!,
          "__proto__",
        ),
      ).toBe(false);
    });

    it("leaves primitives and custom decorators untouched by default on ValidationPipe", async () => {
      const pipe = new ValidationPipe();
      expect(await pipe.transform("hello", { type: "query" })).toBe("hello");
      expect(await pipe.transform(42, { type: "param" })).toBe(42);
      expect(await pipe.transform(null, { type: "body" })).toBeNull();

      const customPayload = JSON.parse('{"__proto__":{"keep":true},"v":1}');
      const customResult = (await pipe.transform(customPayload, {
        type: "custom",
      })) as Record<string, unknown>;
      expect(Object.hasOwn(customResult, "__proto__")).toBe(true);

      const customEnabledPipe = new ValidationPipe({
        validateCustomDecorators: true,
      });
      const customPayload2 = JSON.parse('{"__proto__":{"drop":true},"v":1}');
      const customResult2 = (await customEnabledPipe.transform(customPayload2, {
        type: "custom",
      })) as Record<string, unknown>;
      expect(Object.hasOwn(customResult2, "__proto__")).toBe(false);
    });

    it("skips stripProtoKeys when BODY_SANITIZED_SYMBOL is stamped on ValidationPipe", async () => {
      let strippedCount = 0;
      class SpyValidationPipe extends ValidationPipe {
        protected override stripProtoKeys(value: unknown): void {
          strippedCount += 1;
          super.stripProtoKeys(value);
        }
      }
      const pipe = new SpyValidationPipe();
      const sanitized: Record<PropertyKey, unknown> = { ok: true };
      Object.defineProperty(sanitized, BODY_SANITIZED_SYMBOL, {
        value: true,
        enumerable: false,
      });
      await pipe.transform(sanitized, { type: "body" });
      expect(strippedCount).toBe(0);
    });

    it("strips prototype-pollution keys on schemaless StandardSchemaValidationPipe", async () => {
      const pipe = new StandardSchemaValidationPipe();
      const payload = JSON.parse(
        '{"__proto__":{"admin":true},"prototype":{"a":1},"constructor":{"b":2},"safe":"yes"}',
      );

      const result = (await pipe.transform(payload, {
        type: "body",
      })) as Record<string, unknown>;

      expect(Object.hasOwn(result, "__proto__")).toBe(false);
      expect(Object.hasOwn(result, "prototype")).toBe(false);
      expect(Object.hasOwn(result, "constructor")).toBe(false);
      expect(result.safe).toBe("yes");

      // Custom decorator remains untouched when validateCustomDecorators is false
      const customObj = JSON.parse('{"__proto__":{"keep":true}}');
      const customRes = (await pipe.transform(customObj, {
        type: "custom",
      })) as Record<string, unknown>;
      expect(Object.hasOwn(customRes, "__proto__")).toBe(true);

      // Custom decorator IS stripped when validateCustomDecorators is true
      const enabledPipe = new StandardSchemaValidationPipe({
        validateCustomDecorators: true,
      });
      const customObj2 = JSON.parse('{"__proto__":{"drop":true}}');
      const customRes2 = (await enabledPipe.transform(customObj2, {
        type: "custom",
      })) as Record<string, unknown>;
      expect(Object.hasOwn(customRes2, "__proto__")).toBe(false);

      // Primitives remain untouched
      expect(await pipe.transform("abc", { type: "query" })).toBe("abc");
      expect(await pipe.transform(null, { type: "body" })).toBeNull();
    });

    it("skips stripProtoKeys when BODY_SANITIZED_SYMBOL is stamped on StandardSchemaValidationPipe", async () => {
      let strippedCount = 0;
      class SpyStandardPipe extends StandardSchemaValidationPipe {
        protected override stripProtoKeys(value: unknown): void {
          strippedCount += 1;
          super.stripProtoKeys(value);
        }
      }
      const pipe = new SpyStandardPipe();
      const sanitized: Record<PropertyKey, unknown> = { ok: true };
      Object.defineProperty(sanitized, BODY_SANITIZED_SYMBOL, {
        value: true,
        enumerable: false,
      });
      await pipe.transform(sanitized, { type: "body" });
      expect(strippedCount).toBe(0);
    });
  });

  describe("2. StreamableFile errorHandler & errorLogger wiring", () => {
    it("invokes default errorHandler & errorLogger on pre-header stream failure", async () => {
      const logged: Error[] = [];
      const failingStream = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("disk read failed before first chunk");
        },
      });
      const file = new StreamableFile(failingStream, {
        type: "application/pdf",
        disposition: 'attachment; filename="report.pdf"',
      });
      file.setErrorLogger((err) => logged.push(err));

      const ctx = new RequestContext({
        request: new Request("http://localhost/download"),
      });
      const response = await serializeResponseMaybeAsync(
        file,
        { method: "GET" },
        ctx,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Bad Request");
      expect(logged).toHaveLength(1);
      expect(logged[0]?.message).toBe("disk read failed before first chunk");
    });

    it("invokes custom setErrorHandler on pre-header failure and returns custom Response", async () => {
      const failingStream = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("missing upstream object");
        },
      });
      const file = new StreamableFile(failingStream);
      file.setErrorHandler((err, res) => {
        if (!res) return;
        res.statusCode = 502;
        res.send?.({ error: "UpstreamFailed", detail: err.message });
      });

      const ctx = new RequestContext({
        request: new Request("http://localhost/download"),
      });
      const response = await serializeResponseMaybeAsync(
        file,
        { method: "GET" },
        ctx,
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "UpstreamFailed",
        detail: "missing upstream object",
      });
    });

    it("invokes errorHandler with headersSent: true and errorLogger on mid-stream failure", async () => {
      const logged: Error[] = [];
      const handlerCalls: Array<{ message: string; headersSent?: boolean }> =
        [];
      let pulls = 0;
      const midFailStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode("chunk-1"));
            return;
          }
          throw new Error("connection reset mid-stream");
        },
      });

      const file = new StreamableFile(midFailStream, {
        type: "text/plain",
      });
      const defaultHandler = file.errorHandler;
      file.setErrorLogger((err) => logged.push(err));
      file.setErrorHandler((err, res) => {
        handlerCalls.push({
          message: err.message,
          headersSent: res?.headersSent,
        });
        defaultHandler(err, res);
      });

      const ctx = new RequestContext({
        request: new Request("http://localhost/download"),
      });
      const response = await serializeResponseMaybeAsync(
        file,
        { method: "GET" },
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain");

      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("chunk-1");

      let caught: unknown;
      try {
        await reader.read();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("connection reset mid-stream");
      expect(handlerCalls).toEqual([
        { message: "connection reset mid-stream", headersSent: true },
      ]);
      expect(logged).toHaveLength(1);
      expect(logged[0]?.message).toBe("connection reset mid-stream");
    });

    it("cancels ReadableStream-backed StreamableFile on HEAD/204/304 without pulling", async () => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const file = new StreamableFile(stream, { type: "application/octet-stream" });
      const ctx = new RequestContext({
        request: new Request("http://localhost/download", { method: "HEAD" }),
      });
      const response = await serializeResponseMaybeAsync(
        file,
        { method: "HEAD" },
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
      expect(cancelled).toBe(true);
    });
  });

  describe("3. Bare Web ReadableStream returned from non-SSE controller handlers", () => {
    it("streams bare ReadableStream with merged headers and status via BunestApplication", async () => {
      @Controller("streams")
      class StreamController {
        @Get("text")
        @HttpCode(202)
        @Header("X-Stream-Mode", "bare")
        getTextStream(@Res({ passthrough: true }) res: ResponseContext) {
          res.header("X-Dynamic", "yes");
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue("hello ");
              controller.enqueue("world");
              controller.close();
            },
          });
        }

        @Get("empty")
        @HttpCode(204)
        getNoContentStream() {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          });
        }
      }

      @Module({ controllers: [StreamController] })
      class StreamAppModule {}

      const app = await BunestFactory.create(StreamAppModule, { logger: false });
      await app.init();

      const res = await app.inject({ method: "GET", url: "/streams/text" });
      expect(res.statusCode).toBe(202);
      expect(res.headers["x-stream-mode"]).toBe("bare");
      expect(res.headers["x-dynamic"]).toBe("yes");
      expect(String(res.headers["content-type"])).toContain("text/plain");
      expect(res.body).toBe("hello world");

      const emptyRes = await app.inject({
        method: "GET",
        url: "/streams/empty",
      });
      expect(emptyRes.statusCode).toBe(204);
      expect(emptyRes.body).toBe("");

      await app.close();
    });

    it("cancels bare ReadableStream on HEAD, 204, and 304", async () => {
      for (const [method, httpCode] of [
        ["HEAD", 200],
        ["GET", 204],
        ["GET", 304],
      ] as const) {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([9, 9]));
          },
          cancel() {
            cancelled = true;
          },
        });
        const ctx = new RequestContext({
          request: new Request("http://localhost/s", { method }),
        });
        const res = await serializeResponseMaybeAsync(
          stream,
          { method, httpCode },
          ctx,
        );
        expect(res.status).toBe(httpCode);
        expect(res.body).toBeNull();
        expect(cancelled).toBe(true);
      }
    });
  });

  describe("4. ES2022 error.cause chain & enumerable custom properties in exception logs", () => {
    it("logs cause chain and custom properties while keeping production HTTP response redacted", async () => {
      const loggedCalls: Array<{ msg: unknown; trace: unknown }> = [];
      const mockLogger: LoggerService = {
        log() {},
        error(msg: unknown, trace?: unknown) {
          loggedCalls.push({ msg, trace });
        },
        warn() {},
      };

      const root = Object.assign(new Error("ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
        detail: "postgres down",
      });
      const outer = Object.assign(new Error("Query failed", { cause: root }), {
        code: "DB_QUERY_ERR",
      });

      const filter = new DefaultExceptionFilter({
        development: false,
        logger: mockLogger,
      });
      const ctx = new RequestContext({
        request: new Request("http://localhost/users"),
      });
      const response = filter.catch(outer, createMockArgumentsHost(), ctx);

      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.message).toBe("Internal server error");
      expect(body.stack).toBeUndefined();
      expect(body.cause).toBeUndefined();
      expect(body.code).toBeUndefined();
      expect(body.detail).toBeUndefined();

      expect(loggedCalls).toHaveLength(1);
      expect(loggedCalls[0]?.msg).toBe("Query failed");
      const trace = String(loggedCalls[0]?.trace);
      expect(trace).toContain("DB_QUERY_ERR");
      expect(trace).toContain("Caused by:");
      expect(trace).toContain("ECONNREFUSED 127.0.0.1:5432");
      expect(trace).toContain("postgres down");
    });

    it("handles circular cause chains and bounds cause depth safely", () => {
      const a: Error & { cause?: unknown } = new Error("cycle-a");
      const b: Error & { cause?: unknown } = new Error("cycle-b", { cause: a });
      a.cause = b;

      const cyclicLog = formatErrorForInternalLog(a)!;
      expect(cyclicLog).toContain("cycle-a");
      expect(cyclicLog).toContain("cycle-b");
      expect(cyclicLog).toContain("[Circular]");

      let deep: Error = new Error("leaf");
      for (let i = 0; i < 15; i++) {
        deep = new Error(`level-${i}`, { cause: deep });
      }
      const deepLog = formatErrorForInternalLog(deep)!;
      expect(deepLog).toContain("[Max cause depth reached]");
    });

    it("preserves exact stack output for plain errors without cause or custom properties", () => {
      const plain = new Error("plain failure");
      expect(formatErrorForInternalLog(plain)).toBe(plain.stack);
    });

    it("redacts HTTP response in BaseExceptionFilter", async () => {
      const filter = new BaseExceptionFilter();
      const root = Object.assign(new Error("secret cause"), { code: "SECRET" });
      const err = new Error("outer", { cause: root });
      const res = filter.catch(err, createMockArgumentsHost()) as Response;
      expect(res.status).toBe(500);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toEqual({
        statusCode: 500,
        message: "Internal server error",
      });
    });
  });

  describe("5. 413 PayloadTooLargeException includes configured byte limit", () => {
    it("includes limit on JSON body-parser 413 response (Content-Length & chunked)", async () => {
      const oversized = JSON.stringify({ data: "x".repeat(200) });
      const reqWithCl = new Request("http://localhost/upload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(oversized.length),
        },
        body: oversized,
      });

      let caught: unknown;
      try {
        await parseRequestBody(reqWithCl, { maxBodyBytes: 64 });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PayloadTooLargeException);
      const exc = caught as PayloadTooLargeException;
      expect(exc.getStatus()).toBe(413);
      expect(exc.message).toContain("64 bytes");
      expect((exc.getResponse() as Record<string, unknown>).limit).toBe(64);
      expect(exc.toJSON().limit).toBe(64);

      // Chunked stream (no Content-Length)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      });
      const chunkedReq = new Request("http://localhost/upload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
        body: stream,
      });

      let caughtChunked: unknown;
      try {
        await parseRequestBody(chunkedReq, { maxBodyBytes: 32 });
      } catch (err) {
        caughtChunked = err;
      }
      expect(caughtChunked).toBeInstanceOf(PayloadTooLargeException);
      expect(
        ((caughtChunked as PayloadTooLargeException).getResponse() as Record<
          string,
          unknown
        >).limit,
      ).toBe(32);
    });

    it("includes limit on multipart in-memory and disk parser 413 rejections", async () => {
      const form = new FormData();
      form.append(
        "file",
        new File([new Uint8Array(128)], "big.bin", {
          type: "application/octet-stream",
        }),
      );
      const req = new Request("http://localhost/multipart", {
        method: "POST",
        body: form,
      });

      let caughtMem: unknown;
      try {
        await parseRequestBody(req, {
          multipart: { maxFileSize: 50 },
        });
      } catch (err) {
        caughtMem = err;
      }
      expect(caughtMem).toBeInstanceOf(PayloadTooLargeException);
      expect(
        ((caughtMem as PayloadTooLargeException).getResponse() as Record<
          string,
          unknown
        >).limit,
      ).toBe(50);

      // Disk storage multipart
      const form2 = new FormData();
      form2.append(
        "file",
        new File([new Uint8Array(128)], "big-disk.bin", {
          type: "application/octet-stream",
        }),
      );
      const req2 = new Request("http://localhost/multipart-disk", {
        method: "POST",
        body: form2,
      });

      const tempDir =
        process.env.TEMP ?? process.env.TMP ?? process.env.TMPDIR ?? "/tmp";
      let caughtDisk: unknown;
      try {
        await parseRequestBody(req2, {
          multipart: {
            diskStorageDir: tempDir,
            maxFileSize: 40,
          },
        });
      } catch (err) {
        caughtDisk = err;
      }
      expect(caughtDisk).toBeInstanceOf(PayloadTooLargeException);
      expect(
        ((caughtDisk as PayloadTooLargeException).getResponse() as Record<
          string,
          unknown
        >).limit,
      ).toBe(40);
    });
  });

  describe("6. ParseIntPipe & ParseFloatPipe min/max bounds", () => {
    it("enforces inclusive min and max on ParseIntPipe", async () => {
      const pipe = new ParseIntPipe({ min: 0, max: 10 });
      expect(await pipe.transform("0")).toBe(0);
      expect(await pipe.transform("10")).toBe(10);
      expect(await pipe.transform("5")).toBe(5);

      await expect(pipe.transform("-1")).rejects.toThrow(
        "must not be less than 0",
      );
      await expect(pipe.transform("11")).rejects.toThrow(
        "must not be greater than 10",
      );

      const optionalPipe = new ParseIntPipe({
        min: 1,
        max: 5,
        optional: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_CONTENT,
      });
      expect(await optionalPipe.transform(undefined)).toBeUndefined();
      let err: unknown;
      try {
        await optionalPipe.transform("0");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(422);
    });

    it("enforces inclusive min and max on ParseFloatPipe", async () => {
      const pipe = new ParseFloatPipe({ min: -1.5, max: 2.5 });
      expect(await pipe.transform("-1.5")).toBe(-1.5);
      expect(await pipe.transform("2.5")).toBe(2.5);
      expect(await pipe.transform("0.25")).toBe(0.25);

      await expect(pipe.transform("-1.6")).rejects.toThrow(
        "must not be less than -1.5",
      );
      await expect(pipe.transform("2.6")).rejects.toThrow(
        "must not be greater than 2.5",
      );
    });
  });

  describe("7. ValidationPipe disableFlattenErrorMessages & flatExceptionFactory", () => {
    const sampleErrors: ValidationError[] = [
      {
        property: "user",
        children: [
          {
            property: "email",
            children: [],
            constraints: { isEmail: "email must be an email" },
          },
        ],
      },
    ];

    it("preserves Bunest default 'bunest' errorFormat when new options are omitted", () => {
      const pipe = new ValidationPipe();
      const exc = pipe.createExceptionFactory()(sampleErrors) as HttpException;
      const body = exc.getResponse() as Record<string, unknown>;
      expect(body.message).toBe("Validation failed");
      expect(Array.isArray(body.details)).toBe(true);
    });

    it("emits raw ValidationError[] when disableFlattenErrorMessages is true", () => {
      const pipe = new ValidationPipe({ disableFlattenErrorMessages: true });
      const exc = pipe.createExceptionFactory()(sampleErrors) as HttpException;
      const body = exc.getResponse() as Record<string, unknown>;
      expect(body.statusCode).toBe(400);
      expect(Array.isArray(body.message)).toBe(true);
      expect((body.message as ValidationError[])[0]?.property).toBe("user");
      expect(
        (body.message as ValidationError[])[0]?.children?.[0]?.property,
      ).toBe("email");
    });

    it("passes flattened string[] to custom exceptionFactory when flatExceptionFactory is true", async () => {
      class DummyDto {
        email?: string;
      }
      let received: string[] | undefined;
      const pipe = new ValidationPipe({
        flatExceptionFactory: true,
        validatorPackage: {
          validate: async () => sampleErrors,
        },
        transformerPackage: {
          plainToInstance: (_cls, plain) => Object.assign(new DummyDto(), plain),
        },
        exceptionFactory: (messages) => {
          received = messages;
          return new HttpException({ messages }, HttpStatus.BAD_REQUEST);
        },
      });

      await expect(
        pipe.transform({ email: "bad" }, { type: "body", metatype: DummyDto }),
      ).rejects.toThrow(HttpException);
      expect(received).toEqual(["user.email must be an email"]);
    });
  });

  describe("8. ReadonlyArray in ModuleMetadata & augmentable HttpAdapterTypes", () => {
    it("accepts ReadonlyArray (as const) in @Module metadata", async () => {
      @Injectable()
      class ReadonlyService {
        value() {
          return "readonly-ok";
        }
      }

      @Controller("ro")
      class ReadonlyController {
        constructor(private readonly svc: ReadonlyService) {}
        @Get()
        get() {
          return this.svc.value();
        }
      }

      const providers = [ReadonlyService] as const;
      const controllers = [ReadonlyController] as const;
      const imports = [] as const;
      const exportsList = [ReadonlyService] as const;

      const meta: ModuleMetadata = {
        imports,
        controllers,
        providers,
        exports: exportsList,
      };
      expect(meta.providers).toBe(providers);

      @Module({
        imports,
        controllers,
        providers,
        exports: exportsList,
      })
      class ReadonlyModule {}

      const app = await BunestFactory.create(ReadonlyModule, { logger: false });
      await app.init();
      const res = await app.inject({ method: "GET", url: "/ro" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("readonly-ok");
      await app.close();
    });

    it("defaults HttpArgumentsHost getRequest/getResponse to Request / ResponseContext", () => {
      const host = createMockArgumentsHost();
      const req: Request = host.switchToHttp().getRequest();
      const res: ResponseContext = host.switchToHttp().getResponse();
      const _adapterTypesCheck: HttpAdapterTypes = {};
      expect(req).toBeInstanceOf(Request);
      expect(res).toBeUndefined();
      expect(_adapterTypesCheck).toEqual({});
    });
  });

  describe("9. HTTP Statuses & Built-in Exceptions (402, 422 alias, 423, 425)", () => {
    it("exports HttpStatus.UNPROCESSABLE_CONTENT, TOO_EARLY, and LOCKED", () => {
      expect(HttpStatus.UNPROCESSABLE_CONTENT).toBe(422);
      expect(HttpStatus.UNPROCESSABLE_CONTENT).toBe(
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
      expect(HttpStatus.LOCKED).toBe(423);
      expect(HttpStatus.TOO_EARLY).toBe(425);
    });

    it("exports PaymentRequiredException (402) and LockedException (423)", () => {
      const paymentErr = new PaymentRequiredException("Subscription required");
      expect(paymentErr).toBeInstanceOf(HttpException);
      expect(paymentErr.getStatus()).toBe(402);
      expect(paymentErr.toJSON()).toEqual({
        statusCode: 402,
        message: "Subscription required",
        error: "Payment Required",
      });

      const defaultPaymentErr = new PaymentRequiredException();
      expect(defaultPaymentErr.getStatus()).toBe(402);
      expect(defaultPaymentErr.toJSON().error).toBe("Payment Required");

      const lockedErr = new LockedException("Resource is locked");
      expect(lockedErr).toBeInstanceOf(HttpException);
      expect(lockedErr.getStatus()).toBe(423);
      expect(lockedErr.toJSON()).toEqual({
        statusCode: 423,
        message: "Resource is locked",
        error: "Locked",
      });

      const defaultLockedErr = new LockedException();
      expect(defaultLockedErr.getStatus()).toBe(423);
      expect(defaultLockedErr.toJSON().error).toBe("Locked");
    });
  });
});
