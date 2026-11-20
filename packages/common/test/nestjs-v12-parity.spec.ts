import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { IsEmail, IsInt, IsString, Min } from "class-validator";
import {
  Body,
  CLASS_SERIALIZER_OPTIONS,
  CONFIGURABLE_MODULE_ID,
  ClassSerializerInterceptor,
  ConfigurableModuleBuilder,
  ConsoleLogger,
  DefaultValuePipe,
  FileTypeValidator,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  MaxFileSizeValidator,
  MetadataRegistry,
  METADATA_KEYS,
  Param,
  ParseArrayPipe,
  ParseBoolPipe,
  ParseDatePipe,
  ParseEnumPipe,
  ParseFilePipe,
  ParseFloatPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  SerializeOptions,
  ShutdownSignal,
  StandardSchemaSerializerInterceptor,
  StandardSchemaValidationPipe,
  StreamableFile,
  ValidationPipe,
  DEFAULT_MAX_ERROR_MESSAGES_LENGTH,
  OMITTED_ERRORS_MESSAGE,
  resolveMaxErrorMessagesLength,
  forwardRef,
  type ArgumentMetadata,
  type HostComponentInfo,
  type HttpServer,
  type INestMicroservice,
  type LogLevel,
  type MessageEvent,
  type NestHybridApplicationOptions,
  type ParameterDecoratorOptions,
  type StandardSchemaV1,
  type UploadedFileInfo,
  type ValueProvider,
  type WebSocketAdapter,
} from "../src";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function makeUploadedFile(
  bytes: Uint8Array,
  mimetype: string,
  originalname = "file.bin",
): UploadedFileInfo {
  return {
    fieldname: "file",
    originalname,
    mimetype,
    size: bytes.byteLength,
    buffer: bytes,
    file: new File([bytes], originalname, { type: mimetype }),
  };
}

describe("@bunest/common NestJS v12 API Parity", () => {
  describe("ShutdownSignal runtime enum", () => {
    it("exports all 11 standard POSIX shutdown signals as a runtime enum", () => {
      expect<string>(ShutdownSignal.SIGHUP).toBe("SIGHUP");
      expect<string>(ShutdownSignal.SIGINT).toBe("SIGINT");
      expect<string>(ShutdownSignal.SIGQUIT).toBe("SIGQUIT");
      expect<string>(ShutdownSignal.SIGILL).toBe("SIGILL");
      expect<string>(ShutdownSignal.SIGTRAP).toBe("SIGTRAP");
      expect<string>(ShutdownSignal.SIGABRT).toBe("SIGABRT");
      expect<string>(ShutdownSignal.SIGBUS).toBe("SIGBUS");
      expect<string>(ShutdownSignal.SIGFPE).toBe("SIGFPE");
      expect<string>(ShutdownSignal.SIGSEGV).toBe("SIGSEGV");
      expect<string>(ShutdownSignal.SIGUSR2).toBe("SIGUSR2");
      expect<string>(ShutdownSignal.SIGTERM).toBe("SIGTERM");
      expect(Object.keys(ShutdownSignal)).toHaveLength(11);
    });
  });

  describe("ArgumentMetadata.schema & Parameter Decorators with StandardSchemaV1", () => {
    const stringSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(val) {
          return typeof val === "string"
            ? { value: val.trim() }
            : { issues: [{ message: "Expected string" }] };
        },
      },
    };

    const idSchema: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(val) {
          const n = Number(val);
          return Number.isInteger(n)
            ? { value: n }
            : { issues: [{ message: "Expected integer" }] };
        },
      },
    };

    it("attaches schema directly via @Body(schema), @Query(schema), @Param(schema), @Headers(schema) and (key, schema, ...pipes)", () => {
      class DemoController {
        handle(
          @Body(stringSchema) body: string,
          @Query("q", stringSchema, ParseIntPipe) q: number,
          @Param(idSchema) params: number,
          @Headers({ property: "x-token", schema: stringSchema, pipes: [ParseIntPipe] })
          token: string,
          @Query("page", ParseIntPipe) page: number,
        ) {
          return { body, q, params, token, page };
        }
      }

      const meta = MetadataRegistry.getRouteParameters(DemoController, "handle");
      expect(meta).toHaveLength(5);

      expect(meta[0]).toMatchObject({
        index: 0,
        source: "body",
        schema: stringSchema,
      });
      expect(meta[0]?.key).toBeUndefined();

      expect(meta[1]).toMatchObject({
        index: 1,
        source: "query",
        key: "q",
        data: "q",
        schema: stringSchema,
        pipes: [ParseIntPipe],
      });

      expect(meta[2]).toMatchObject({
        index: 2,
        source: "param",
        schema: idSchema,
      });

      expect(meta[3]).toMatchObject({
        index: 3,
        source: "header",
        key: "x-token",
        data: "x-token",
        schema: stringSchema,
        pipes: [ParseIntPipe],
      });

      expect(meta[4]).toMatchObject({
        index: 4,
        source: "query",
        key: "page",
        pipes: [ParseIntPipe],
      });
      expect(meta[4]?.schema).toBeUndefined();

      // Compile-time ArgumentMetadata.schema check
      const argMeta: ArgumentMetadata = {
        type: "body",
        schema: stringSchema,
      };
      expect(argMeta.schema).toBe(stringSchema);
    });
  });

  describe("ConfigurableModuleBuilder", () => {
    interface CacheOpts {
      ttl: number;
    }

    it("generates snake-case moduleName token, supports alwaysTransient, provideInjectionTokensFrom, extras, and immutable branching", () => {
      const baseBuilder = new ConfigurableModuleBuilder<CacheOpts>({
        moduleName: "RedisCache",
        alwaysTransient: true,
      });

      const forRootBuilder = baseBuilder
        .setClassMethodName("forRoot")
        .setFactoryMethodName("createCacheOptions")
        .setExtras<{ isGlobal?: boolean }>(
          { isGlobal: false },
          (def, extras) => ({
            ...def,
            global: extras.isGlobal,
          }),
        );

      // Verify immutable branching (baseBuilder still builds default register)
      const defaultHost = baseBuilder.build();
      expect(defaultHost.MODULE_OPTIONS_TOKEN).toBe("REDIS_CACHE_MODULE_OPTIONS");
      expect(typeof defaultHost.ConfigurableModuleClass.register).toBe("function");

      const {
        ConfigurableModuleClass,
        MODULE_OPTIONS_TOKEN,
        OPTIONS_TYPE,
        ASYNC_OPTIONS_TYPE,
      } = forRootBuilder.build();

      expect(MODULE_OPTIONS_TOKEN).toBe("REDIS_CACHE_MODULE_OPTIONS");
      // Accessing type proxies as runtime values throws helpful NestJS error
      expect(() => (OPTIONS_TYPE as any).ttl).toThrow("OPTIONS_TYPE");
      expect(() => (ASYNC_OPTIONS_TYPE as any).useFactory).toThrow(
        "ASYNC_OPTIONS_TYPE",
      );

      class CacheModule extends ConfigurableModuleClass {}

      const dyn1 = CacheModule.forRoot({ ttl: 60, isGlobal: true });
      const dyn2 = CacheModule.forRoot({ ttl: 60, isGlobal: false });

      expect(dyn1.module).toBe(CacheModule);
      expect(dyn1.global).toBe(true);
      expect(dyn2.global).toBe(false);

      // Extras stripped from options provider value
      const optProvider1 = dyn1.providers?.find(
        (p) => typeof p !== "function" && p.provide === MODULE_OPTIONS_TOKEN,
      ) as { useValue: CacheOpts };
      expect(optProvider1.useValue).toEqual({ ttl: 60 });

      // alwaysTransient generates distinct CONFIGURABLE_MODULE_ID per call
      const id1 = dyn1.providers?.find(
        (p) => typeof p !== "function" && p.provide === CONFIGURABLE_MODULE_ID,
      ) as { useValue: string };
      const id2 = dyn2.providers?.find(
        (p) => typeof p !== "function" && p.provide === CONFIGURABLE_MODULE_ID,
      ) as { useValue: string };
      expect(typeof id1.useValue).toBe("string");
      expect(typeof id2.useValue).toBe("string");
      expect(id1.useValue).not.toBe(id2.useValue);

      // provideInjectionTokensFrom filters only providers needed by inject (+ transitive deps)
      const TOKEN_A = Symbol("A");
      const TOKEN_B = Symbol("B");
      const UNUSED_TOKEN = Symbol("UNUSED");
      const parentProviders = [
        { provide: TOKEN_B, useValue: "b-val" },
        {
          provide: TOKEN_A,
          useFactory: (b: string) => `a-${b}`,
          inject: [forwardRef(() => TOKEN_B)],
        },
        { provide: UNUSED_TOKEN, useValue: "unused" },
      ];

      const asyncDyn = CacheModule.forRootAsync({
        isGlobal: true,
        inject: [{ token: TOKEN_A, optional: false }],
        provideInjectionTokensFrom: parentProviders,
        useFactory: (_a: string) => ({ ttl: 120 }),
      });

      expect(asyncDyn.global).toBe(true);
      const providedTokens = (asyncDyn.providers ?? []).map((p) =>
        typeof p === "function" ? p : p.provide,
      );
      expect(providedTokens).toContain(MODULE_OPTIONS_TOKEN);
      expect(providedTokens).toContain(TOKEN_A);
      expect(providedTokens).toContain(TOKEN_B);
      expect(providedTokens).toContain(CONFIGURABLE_MODULE_ID);
      expect(providedTokens).not.toContain(UNUSED_TOKEN);
    });

    it("supports useClass and useExisting with custom factoryMethodName", async () => {
      const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
        new ConfigurableModuleBuilder<CacheOpts>()
          .setClassMethodName("forFeature")
          .setFactoryMethodName("makeConfig")
          .build();

      class CustomFactory {
        async makeConfig(): Promise<CacheOpts> {
          return { ttl: 99 };
        }
      }

      class FeatureModule extends ConfigurableModuleClass {}
      const viaClass = FeatureModule.forFeatureAsync({
        useClass: CustomFactory,
      });
      const optProvider = viaClass.providers?.find(
        (p) => typeof p !== "function" && p.provide === MODULE_OPTIONS_TOKEN,
      ) as { useFactory: (f: CustomFactory) => Promise<CacheOpts> };
      expect(await optProvider.useFactory(new CustomFactory())).toEqual({
        ttl: 99,
      });

      const viaExisting = FeatureModule.forFeatureAsync({
        useExisting: CustomFactory,
      });
      expect(viaExisting.providers).toHaveLength(1);
    });
  });

  describe("Section 1.2 Interface & Member Parity", () => {
    it("supports MessageEvent.comment, ValueProvider.inject?: never, ParameterDecoratorOptions.pipes, NestHybridApplicationOptions.deferInitialization, HostComponentInfo.token, WebSocketAdapter.closeClient, INestMicroservice, and 52-method HttpServer", () => {
      const sseEvent: MessageEvent = { data: "ping", comment: "keep-alive" };
      expect(sseEvent.comment).toBe("keep-alive");

      const valProvider: ValueProvider<number> = { provide: "NUM", useValue: 1 };
      expect(valProvider.inject).toBeUndefined();

      const paramOpts: ParameterDecoratorOptions = { pipes: [ParseIntPipe] };
      expect(paramOpts.pipes).toHaveLength(1);

      const hybridOpts: NestHybridApplicationOptions = {
        inheritAppConfig: true,
        deferInitialization: true,
      };
      expect(hybridOpts.deferInitialization).toBe(true);

      const hostInfo: HostComponentInfo = {
        host: class {},
        isTreeDurable: true,
        token: "TENANT_SVC",
      };
      expect(hostInfo.token).toBe("TENANT_SVC");

      const wsAdapter: WebSocketAdapter = {
        create: () => ({}),
        bindClientConnect: () => {},
        bindMessageHandlers: () => {},
        close: () => {},
        closeClient: () => {},
      };
      expect(typeof wsAdapter.closeClient).toBe("function");

      // Compile-time verification for HttpServer optional methods & INestMicroservice
      const minimalServer: HttpServer = {
        close: () => {},
        get: () => {},
        post: () => {},
        query: () => {},
        setCookie: () => {},
        clearCookie: () => {},
        normalizePath: (p) => p,
      };
      expect(minimalServer.normalizePath?.("/a")).toBe("/a");

      type AssertMicroserviceMethods = Pick<
        INestMicroservice,
        "getTransportServer" | "on" | "registerPreRequestHook"
      >;
      const _msCheck: AssertMicroserviceMethods | null = null;
      expect(_msCheck).toBeNull();
    });
  });

  describe("StreamableFile public options & protected hooks", () => {
    it("exposes public options and allows subclassing protected logger, handleError, logError", () => {
      const logged: Error[] = [];
      const handled: Array<{ err: Error; status?: number }> = [];

      class CustomStreamableFile extends StreamableFile {
        protected override logError = (err: Error) => {
          logged.push(err);
        };
        protected override handleError = (err: Error, res?: any) => {
          handled.push({ err, status: res?.statusCode });
        };
        getLoggerInstance() {
          return this.logger;
        }
      }

      const file = new CustomStreamableFile(PNG_BYTES, {
        type: "image/png",
        disposition: 'inline; filename="a.png"',
      });
      expect(file.options).toEqual({
        type: "image/png",
        disposition: 'inline; filename="a.png"',
      });
      expect(file.getLoggerInstance()).toBeInstanceOf(Logger);

      const err = new Error("stream broken");
      file.errorLogger(err);
      file.errorHandler(err, { statusCode: 500 });
      expect(logged).toEqual([err]);
      expect(handled).toEqual([{ err, status: 500 }]);
    });
  });

  describe("Built-in Pipes, File Validators & Protected Subclass Hooks", () => {
    it("ParseDatePipe supports default() factory and rejects days past month end", () => {
      const fallback = new Date("2026-01-01T00:00:00.000Z");
      const pipe = new ParseDatePipe({ default: () => new Date(fallback) });

      expect(pipe.transform(undefined)?.toISOString()).toBe(
        fallback.toISOString(),
      );
      expect(pipe.transform(null)?.toISOString()).toBe(fallback.toISOString());

      // Valid leap day accepted
      expect(pipe.transform("2024-02-29")?.toISOString()).toContain("2024-02-29");
      // Days past month end rejected (instead of rolling into March!)
      expect(() => pipe.transform("2024-02-30")).toThrow(HttpException);
      expect(() => pipe.transform("2023-02-29")).toThrow(HttpException);
      expect(() => pipe.transform("2024-04-31")).toThrow(HttpException);
    });

    it("FileTypeValidator supports errorMessage (string & fn) and overrideMimeType without breaking text-based MIME types or mutating rejected files", async () => {
      const validator = new FileTypeValidator({
        fileType: "image/png",
        overrideMimeType: true,
        errorMessage: ({ file, config }) =>
          `bad:${file?.mimetype}:want:${String(config.fileType)}`,
      });

      const spoofedAsText = makeUploadedFile(PNG_BYTES, "text/plain", "pic.png");
      expect(await validator.isValid(spoofedAsText)).toBe(true);
      // overrideMimeType updated file.mimetype from magic bytes on valid match
      expect(spoofedAsText.mimetype).toBe("image/png");

      // Failed validation MUST NOT mutate file.mimetype
      const jpegAsPng = makeUploadedFile(JPEG_BYTES, "image/png", "fake.png");
      expect(await validator.isValid(jpegAsPng)).toBe(false);
      expect(jpegAsPng.mimetype).toBe("image/png");
      expect(validator.buildErrorMessage(jpegAsPng)).toBe(
        "bad:image/png:want:image/png",
      );

      // Text-based MIME types (application/json, text/csv) MUST pass & preserve mimetype under overrideMimeType: true
      const jsonValidator = new FileTypeValidator({
        fileType: "application/json",
        overrideMimeType: true,
      });
      const jsonFile = makeUploadedFile(
        new TextEncoder().encode('{"ok":true}'),
        "application/json",
        "data.json",
      );
      expect(await jsonValidator.isValid(jsonFile)).toBe(true);
      expect(jsonFile.mimetype).toBe("application/json");

      // Plain text with mismatched client header gets overridden to text/plain when matching text/plain
      const plainValidator = new FileTypeValidator({
        fileType: "text/plain",
        overrideMimeType: true,
      });
      const plainFile = makeUploadedFile(
        new TextEncoder().encode("hello world"),
        "application/octet-stream",
        "notes.txt",
      );
      expect(await plainValidator.isValid(plainFile)).toBe(true);
      expect(plainFile.mimetype).toBe("text/plain");
    });

    it("MaxFileSizeValidator supports errorMessage (string & fn)", () => {
      const fnValidator = new MaxFileSizeValidator({
        maxSize: 5,
        message: "legacy message",
        errorMessage: ({ file, config }) =>
          `size=${file?.size} > max=${config.maxSize}`,
      });
      const big = makeUploadedFile(PNG_BYTES, "image/png");
      expect(fnValidator.isValid(big)).toBe(false);
      expect(fnValidator.buildErrorMessage(big)).toBe("size=10 > max=5");

      const strValidator = new MaxFileSizeValidator({
        maxSize: 5,
        errorMessage: "Too big!",
      });
      expect(strValidator.buildErrorMessage(big)).toBe("Too big!");
    });

    it("DefaultValuePipe deep-copies plain objects & arrays (preserving circular refs) while returning class instances as-is", () => {
      const defObj: Record<string, any> = { tags: ["a"], nested: { count: 1 } };
      defObj.self = defObj;

      const pipe = new DefaultValuePipe<Record<string, any>>(defObj);
      const copy1 = pipe.transform(undefined);
      const copy2 = pipe.transform(null);

      expect(copy1).not.toBe(defObj);
      expect(copy1).not.toBe(copy2);
      expect(copy1.self).toBe(copy1);
      copy1.tags.push("mutated");
      copy1.nested.count = 999;
      expect(copy2.tags).toEqual(["a"]);
      expect(copy2.nested.count).toBe(1);

      // Non-plain object (Date) returned as-is
      const dateDefault = new Date("2026-05-01T00:00:00.000Z");
      const datePipe = new DefaultValuePipe(dateDefault);
      expect(datePipe.transform(undefined)).toBe(dateDefault);
    });

    it("ParseArrayPipe supports DTO class items via protected validationPipe and 20 validation passthrough options", async () => {
      class ItemDto {
        @IsEmail()
        email!: string;

        @IsInt()
        @Min(1)
        qty!: number;
      }

      const pipe = new ParseArrayPipe({
        items: ItemDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        stopAtFirstError: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      });

      const items = (await pipe.transform(
        [
          { email: "a@example.com", qty: 2 },
          { email: "b@example.com", qty: 5 },
        ],
        { type: "body" },
      )) as ItemDto[];

      expect(items).toHaveLength(2);
      expect(items[0]).toBeInstanceOf(ItemDto);
      expect(items[1]?.qty).toBe(5);

      await expect(
        pipe.transform([{ email: "not-email", qty: 0 }], { type: "body" }),
      ).rejects.toThrow(HttpException);
    });

    it("supports protected subclass hooks on ConsoleLogger, Logger, and built-in pipes", async () => {
      const jsonRecords: Record<string, unknown>[] = [];
      class CustomConsoleLogger extends ConsoleLogger {
        protected override stringifyReplacer(key: string, value: unknown): unknown {
          if (key === "secretTag") return "***";
          return super.stringifyReplacer(key, value);
        }
        protected override printAsJson(message: unknown, options: any): void {
          const obj = this.getJsonLogObject(message, options);
          jsonRecords.push(JSON.parse(this.stringifyJsonLogObject(obj)));
        }
        checkColor(level: LogLevel) {
          return this.getColorByLogLevel(level)("x");
        }
      }

      const cl = new CustomConsoleLogger("SubCtx", { json: true });
      cl.error("failed", new Error("boom"));
      cl.log({ secretTag: "hidden", ok: 1 });
      expect(jsonRecords).toHaveLength(2);
      expect(jsonRecords[0]?.message).toBe("failed");
      expect((jsonRecords[0]?.error as any)?.message).toBe("boom");
      expect((jsonRecords[1]?.message as any)?.secretTag).toBe("***");
      expect(cl.checkColor("warn")).toContain("x");

      class CustomLogger extends Logger {
        getProtectedSnapshot() {
          return {
            context: this.context,
            options: this.options,
            hasLocalRef: this.localInstanceRef === undefined,
            staticLevels: Logger.logLevels,
            bufferLen: Logger.logBuffer.length,
          };
        }
      }
      const logger = new CustomLogger("MyCtx", { timestamp: false });
      expect(logger.getProtectedSnapshot().context).toBe("MyCtx");
      expect(logger.getProtectedSnapshot().options.timestamp).toBe(false);
      expect(Array.isArray(logger.getProtectedSnapshot().staticLevels)).toBe(true);

      // Pipe subclassing checks
      class CustomIntPipe extends ParseIntPipe {
        testIsNumeric(v: unknown) {
          return this.isNumeric(v);
        }
      }
      expect(new CustomIntPipe().testIsNumeric("123")).toBe(true);

      class CustomFloatPipe extends ParseFloatPipe {
        testIsNumeric(v: unknown) {
          return this.isNumeric(v);
        }
      }
      expect(new CustomFloatPipe().testIsNumeric("3.5")).toBe(true);

      class CustomBoolPipe extends ParseBoolPipe {
        testFlags(v: unknown) {
          return [this.isTrue(v), this.isFalse(v)];
        }
      }
      expect(new CustomBoolPipe().testFlags("true")).toEqual([true, false]);

      class CustomUuidPipe extends ParseUUIDPipe {
        testUuid(v: unknown) {
          return this.isUUID(v, "4") && Boolean(ParseUUIDPipe.uuidRegExps["4"]);
        }
      }
      expect(
        new CustomUuidPipe().testUuid("550e8400-e29b-41d4-a716-446655440000"),
      ).toBe(true);

      enum Role {
        ADMIN = "admin",
      }
      class CustomEnumPipe extends ParseEnumPipe<typeof Role> {
        testMeta() {
          return {
            values: this.getEnumValues(),
            valid: this.isEnum("admin"),
            converted: this.toEnumValue("admin"),
          };
        }
      }
      expect(new CustomEnumPipe(Role).testMeta()).toEqual({
        values: ["admin"],
        valid: true,
        converted: "admin",
      });

      class CustomFilePipe extends ParseFilePipe {
        async runValidate(f: UploadedFileInfo) {
          return this.validate(f);
        }
      }
      const f = makeUploadedFile(PNG_BYTES, "image/png");
      expect(await new CustomFilePipe().runValidate(f)).toBe(f);
    });
  });

  describe("Direct @bunest/common validation & serializer exports", () => {
    it("exports ValidationPipe, ClassSerializerInterceptor, StandardSchemaValidationPipe, StandardSchemaSerializerInterceptor, SerializeOptions, and validation constants directly from @bunest/common", () => {
      expect(typeof ValidationPipe).toBe("function");
      expect(typeof ClassSerializerInterceptor).toBe("function");
      expect(typeof StandardSchemaValidationPipe).toBe("function");
      expect(typeof StandardSchemaSerializerInterceptor).toBe("function");
      expect(typeof SerializeOptions).toBe("function");
      expect(typeof CLASS_SERIALIZER_OPTIONS).toBe("symbol");
      expect(DEFAULT_MAX_ERROR_MESSAGES_LENGTH).toBe(1_000_000);
      expect(OMITTED_ERRORS_MESSAGE).toBe(
        "Further validation errors were omitted",
      );
      expect(resolveMaxErrorMessagesLength(undefined)).toBe(1_000_000);
    });
  });
});
