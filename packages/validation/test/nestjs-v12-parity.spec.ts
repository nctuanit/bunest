import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as CommonPkg from "@bunest/common";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Reflector,
  StreamableFile,
  type ArgumentMetadata,
  type CallHandler,
  type ExecutionContext,
  type StandardSchemaV1,
  type ValidationErrorResponse,
} from "@bunest/common";
import { IsEmail, IsString, MinLength } from "class-validator";
import {
  CLASS_SERIALIZER_OPTIONS,
  ClassSerializerInterceptor,
  DEFAULT_MAX_ERROR_MESSAGES_LENGTH,
  OMITTED_ERRORS_MESSAGE,
  SerializeOptions,
  StandardSchemaSerializerInterceptor,
  StandardSchemaValidationPipe,
  UseStandardSchema,
  ValidationPipe,
  resolveMaxErrorMessagesLength,
  type PlainLiteralObject,
  type ValidationError,
  type ValidationErrorFormat,
} from "../src";

function makeContext(
  controllerClass: Function,
  handler: Function,
): ExecutionContext {
  return {
    getClass: () => controllerClass as any,
    getHandler: () => handler,
    getArgs: () => [] as any,
    getArgByIndex: () => undefined as any,
    getType: () => "http" as any,
    switchToHttp: () => ({
      getRequest: () => new Request("http://localhost/test") as any,
      getResponse: () => ({}) as any,
      getNext: () => (() => undefined) as any,
    }),
    switchToRpc: () => ({
      getData: () => undefined as any,
      getContext: () => undefined as any,
    }),
    switchToWs: () => ({
      getData: () => undefined as any,
      getClient: () => undefined as any,
      getPattern: () => "",
    }),
  };
}

function makeNext<T>(value: T): CallHandler<T> {
  return { async handle() { return value; } };
}

describe("@bunest/validation NestJS v12 API Parity", () => {
  describe("Constants, helpers & canonical cross-package identity", () => {
    it("exports DEFAULT_MAX_ERROR_MESSAGES_LENGTH, OMITTED_ERRORS_MESSAGE, resolveMaxErrorMessagesLength, and re-exported types", () => {
      expect(DEFAULT_MAX_ERROR_MESSAGES_LENGTH).toBe(1_000_000);
      expect(OMITTED_ERRORS_MESSAGE).toBe(
        "Further validation errors were omitted",
      );
      expect(resolveMaxErrorMessagesLength(undefined)).toBe(1_000_000);
      expect(resolveMaxErrorMessagesLength(Number.NaN)).toBe(1_000_000);
      expect(resolveMaxErrorMessagesLength(0)).toBe(0);
      expect(resolveMaxErrorMessagesLength(250)).toBe(250);
      expect(resolveMaxErrorMessagesLength(Number.POSITIVE_INFINITY)).toBe(
        Number.POSITIVE_INFINITY,
      );

      // Type-level verification
      const obj: PlainLiteralObject = { ok: true };
      const err: ValidationError = { property: "email" };
      const fmt: ValidationErrorFormat = "grouped";
      expect(obj.ok).toBe(true);
      expect(err.property).toBe("email");
      expect(fmt).toBe("grouped");
    });

    it("shares canonical class & symbol identity with @bunest/common", () => {
      expect(ValidationPipe).toBe(CommonPkg.ValidationPipe);
      expect(ClassSerializerInterceptor).toBe(
        CommonPkg.ClassSerializerInterceptor,
      );
      expect(StandardSchemaValidationPipe).toBe(
        CommonPkg.StandardSchemaValidationPipe,
      );
      expect(StandardSchemaSerializerInterceptor).toBe(
        CommonPkg.StandardSchemaSerializerInterceptor,
      );
      expect(SerializeOptions).toBe(CommonPkg.SerializeOptions);
      expect(CLASS_SERIALIZER_OPTIONS).toBe(CommonPkg.CLASS_SERIALIZER_OPTIONS);
    });
  });

  describe("StandardSchemaValidationPipe (global & per-schema modes)", () => {
    const receivedOpts: unknown[] = [];
    const trimSchema: StandardSchemaV1<unknown, { name: string }> = {
      "~standard": {
        version: 1,
        vendor: "test-std",
        validate(input, opts) {
          receivedOpts.push(opts);
          if (
            typeof input !== "object" ||
            input === null ||
            typeof (input as any).name !== "string"
          ) {
            return {
              issues: [{ message: "name must be a string", path: ["name"] }],
            };
          }
          return { value: { name: (input as any).name.trim() } };
        },
      },
    };

    it("works as a NestJS v12 global pipe reading metadata.schema and passing through when absent", async () => {
      const globalPipe = new StandardSchemaValidationPipe();
      const untouched = { raw: 1 };
      expect(await globalPipe.transform(untouched, { type: "body" })).toBe(
        untouched,
      );

      const transformed = await globalPipe.transform(
        { name: "  Ada  " },
        { type: "body", schema: trimSchema },
      );
      expect(transformed).toEqual({ name: "Ada" });

      await expect(
        globalPipe.transform(
          { name: 123 },
          { type: "body", schema: trimSchema },
        ),
      ).rejects.toThrow(HttpException);
    });

    it("respects transform: false, validateOptions, and maxErrorMessagesLength", async () => {
      receivedOpts.length = 0;
      const pipe = new StandardSchemaValidationPipe({
        transform: false,
        validateOptions: { libraryOptions: { abortEarly: true } },
      });

      const original = { name: "  Grace  " };
      const out = await pipe.transform(original, {
        type: "body",
        schema: trimSchema,
      });
      // transform: false returns the original input reference after validation
      expect(out).toBe(original);
      expect(receivedOpts[0]).toEqual({ libraryOptions: { abortEarly: true } });

      // maxErrorMessagesLength truncation
      const manyIssuesSchema: StandardSchemaV1 = {
        "~standard": {
          version: 1,
          vendor: "many",
          validate() {
            return {
              issues: [
                { message: "first error message", path: ["field1"] },
                { message: "second error message", path: ["field2"] },
                { message: "third error message", path: ["field3"] },
              ],
            };
          },
        },
      };

      const limitedPipe = new StandardSchemaValidationPipe(manyIssuesSchema, {
        maxErrorMessagesLength: 20,
      });
      try {
        await limitedPipe.transform({}, { type: "body" });
        throw new Error("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const body = (err as HttpException).getResponse() as unknown as ValidationErrorResponse;
        expect(body.details.some((d) => d.messages.includes(OMITTED_ERRORS_MESSAGE))).toBe(true);
      }

      // Custom exceptionFactory receives ALL issues regardless of maxErrorMessagesLength
      let customIssueCount = 0;
      const customFactoryPipe = new StandardSchemaValidationPipe(
        manyIssuesSchema,
        {
          maxErrorMessagesLength: 5,
          exceptionFactory: (issues) => {
            customIssueCount = issues.length;
            return new BadRequestException("custom");
          },
        },
      );
      await expect(
        customFactoryPipe.transform({}, { type: "body" }),
      ).rejects.toThrow(BadRequestException);
      expect(customIssueCount).toBe(3);
    });

    it("supports protected subclass hooks (toValidate, validate, formatIssueMessages, stripProtoKeys)", async () => {
      const hookLog: string[] = [];

      class CustomStdPipe extends StandardSchemaValidationPipe {
        protected override toValidate(metadata: ArgumentMetadata): boolean {
          hookLog.push(`toValidate:${metadata.type}`);
          return super.toValidate(metadata);
        }
        protected override stripProtoKeys(value: any): void {
          hookLog.push("stripProtoKeys");
          super.stripProtoKeys(value);
        }
        protected override validate<T = unknown>(
          value: unknown,
          schema: StandardSchemaV1,
          options?: Record<string, unknown>,
        ) {
          hookLog.push("validate");
          return super.validate<T>(value, schema, options);
        }
        testFormat(issues: readonly CommonPkg.StandardSchemaV1Issue[]) {
          return this.formatIssueMessages(issues);
        }
      }

      const pipe = new CustomStdPipe({ maxErrorMessagesLength: 10 });
      await pipe.transform({ name: "  hi " }, { type: "body", schema: trimSchema });
      expect(hookLog).toEqual(["toValidate:body", "stripProtoKeys", "validate"]);

      const formatted = pipe.testFormat([
        { message: "is invalid", path: ["user", "email"] },
        { message: "should be omitted", path: ["other"] },
      ]);
      expect(formatted).toEqual(["user.email: is invalid", OMITTED_ERRORS_MESSAGE]);
    });
  });

  describe("StandardSchemaSerializerInterceptor (@SerializeOptions + serialize + transformToPlain)", () => {
    const receivedValidateOpts: unknown[] = [];

    const userSchema: StandardSchemaV1<unknown, { id: number; name: string }> = {
      "~standard": {
        version: 1,
        vendor: "test-ser",
        validate(val, opts) {
          receivedValidateOpts.push(opts);
          if (typeof val !== "object" || val === null || typeof (val as any).id !== "number") {
            return { issues: [{ message: "invalid id", path: ["id"] }] };
          }
          return {
            value: { id: (val as any).id, name: String((val as any).name ?? "") },
          };
        },
      },
    };

    @SerializeOptions({ schema: userSchema, validateOptions: { libraryOptions: { mode: "class" } } })
    class ProfileController {
      list() {}

      @SerializeOptions({ validateOptions: { libraryOptions: { mode: "handler" } } })
      listWithHandlerOpts() {}

      @UseStandardSchema(userSchema)
      legacyUseStandardSchema() {}
    }

    it("reads @SerializeOptions({ schema, validateOptions }), merges handler validateOptions with class schema, and serializes arrays", async () => {
      receivedValidateOpts.length = 0;
      const interceptor = new StandardSchemaSerializerInterceptor(new Reflector());

      // Class-level @SerializeOptions({ schema }) serializes single & array responses
      const listCtx = makeContext(ProfileController, ProfileController.prototype.list);
      const listOut = await interceptor.intercept(
        listCtx,
        makeNext([
          { id: 1, name: "Ada", secret: "drop" },
          { id: 2, name: "Grace", secret: "drop" },
        ]),
      );
      expect(listOut).toEqual([
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ]);
      expect(receivedValidateOpts[0]).toEqual({ libraryOptions: { mode: "class" } });

      // Handler sets ONLY validateOptions -> preserves class schema!
      receivedValidateOpts.length = 0;
      const handlerOptsCtx = makeContext(
        ProfileController,
        ProfileController.prototype.listWithHandlerOpts,
      );
      const singleOut = await interceptor.intercept(
        handlerOptsCtx,
        makeNext({ id: 9, name: "Lin", passwordHash: "nope" }),
      );
      expect(singleOut).toEqual({ id: 9, name: "Lin" });
      expect(receivedValidateOpts[0]).toEqual({ libraryOptions: { mode: "handler" } });

      // Public serialize() and transformToPlain() directly callable
      expect(
        await interceptor.transformToPlain(
          { id: 3, name: "Bob", hidden: true },
          userSchema,
        ),
      ).toEqual({ id: 3, name: "Bob" });

      const streamable = new StreamableFile(new Uint8Array([1, 2]));
      expect(interceptor.serialize(streamable as any, userSchema)).toBe(
        streamable as any,
      );
      expect(interceptor.serialize({ a: 1 }, undefined)).toEqual({ a: 1 });
    });

    it("supports protected reflector, defaultOptions, and getContextOptions in subclasses", () => {
      class SubSerializer extends StandardSchemaSerializerInterceptor {
        inspect(ctx: ExecutionContext) {
          return {
            hasReflector: this.reflector instanceof Reflector,
            defaultOpts: this.defaultOptions,
            ctxOpts: this.getContextOptions(ctx),
          };
        }
      }

      const sub = new SubSerializer(new Reflector(), {
        validateOptions: { libraryOptions: { strict: true } },
      });
      const info = sub.inspect(
        makeContext(ProfileController, ProfileController.prototype.list),
      );
      expect(info.hasReflector).toBe(true);
      expect(info.defaultOpts.validateOptions).toEqual({
        libraryOptions: { strict: true },
      });
      expect(info.ctxOpts?.schema).toBe(userSchema);
    });
  });

  describe("ValidationPipe createExceptionFactory() & protected subclass hooks", () => {
    class SampleDto {
      @IsEmail()
      email!: string;

      @IsString()
      @MinLength(3)
      name!: string;
    }

    it("exposes public createExceptionFactory() supporting bunest, list, and grouped formats with OMITTED_ERRORS_MESSAGE", () => {
      const errors: ValidationError[] = [
        { property: "email", constraints: { isEmail: "email must be an email" } },
        { property: "name", constraints: { minLength: "name is too short" } },
      ];

      // Default ADR-009 bunest format
      const bunestPipe = new ValidationPipe();
      const bunestErr = bunestPipe.createExceptionFactory()(errors) as HttpException;
      expect(bunestErr).toBeInstanceOf(BadRequestException);
      expect((bunestErr.getResponse() as any).details).toHaveLength(2);

      // NestJS "list" format with truncation
      const listPipe = new ValidationPipe({
        errorFormat: "list",
        maxErrorMessagesLength: 10,
      });
      const listErr = listPipe.createExceptionFactory()(errors) as HttpException;
      expect((listErr.getResponse() as any).message).toEqual([
        "email must be an email",
        OMITTED_ERRORS_MESSAGE,
      ]);

      // NestJS "grouped" format with truncation
      const groupedPipe = new ValidationPipe({
        errorFormat: "grouped",
        maxErrorMessagesLength: 10,
      });
      const groupedErr = groupedPipe.createExceptionFactory()(errors) as HttpException;
      expect((groupedErr.getResponse() as any).message).toEqual({
        email: ["email must be an email"],
        "...": [OMITTED_ERRORS_MESSAGE],
      });
    });

    it("supports overriding createExceptionFactory() and accessing protected hooks in subclasses", async () => {
      class CustomValidationPipe extends ValidationPipe {
        override createExceptionFactory() {
          return (errors: ValidationError[] = []) =>
            new HttpException(
              { customCount: errors.length },
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }
        async checkHooks() {
          const isPrim = this.isPrimitive("abc");
          const isBin = this.isBinary(new Uint8Array([1]));
          const emptyNil = this.toEmptyIfNil(undefined, SampleDto);
          const hasRules = await this.hasValidationRules(SampleDto);
          const grouped = this.groupValidationErrors([
            {
              property: "nested",
              children: [
                { property: "city", constraints: { isString: "must be string" } },
              ],
            },
          ]);
          const flat = this.flattenValidationErrors([
            {
              property: "nested",
              children: [
                { property: "city", constraints: { isString: "city must be string" } },
              ],
            },
          ]);
          const binErrors = this.findNestedBinaryValues({
            payload: new Uint8Array([1, 2]),
          });
          return { isPrim, isBin, emptyNil, hasRules, grouped, flat, binErrors };
        }
      }

      const pipe = new CustomValidationPipe();
      const hooks = await pipe.checkHooks();
      expect(hooks.isPrim).toBe(true);
      expect(hooks.isBin).toBe(true);
      expect(hooks.emptyNil).toEqual({});
      expect(hooks.hasRules).toBe(true);
      expect(hooks.grouped).toEqual({ "nested.city": ["must be string"] });
      expect(hooks.flat).toEqual(["nested.city must be string"]);
      expect(hooks.binErrors).toHaveLength(1);

      try {
        await pipe.transform(
          { email: "bad", name: "a" },
          { type: "body", metatype: SampleDto },
        );
        throw new Error("expected failure");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(422);
        expect((err as HttpException).getResponse()).toEqual({ customCount: 2 });
      }
    });
  });

  describe("ClassSerializerInterceptor transformerPackage & protected hooks", () => {
    it("uses injected transformerPackage and exposes protected reflector, defaultOptions, and getContextOptions", async () => {
      const calls: string[] = [];
      const customTransformer = {
        plainToInstance: <T>(_cls: any, plain: any) => {
          calls.push("plainToInstance");
          return plain as T;
        },
        instanceToPlain: (obj: any) => {
          calls.push("instanceToPlain");
          return { ...obj, transformedBy: "custom" };
        },
      };

      class SubClassSerializer extends ClassSerializerInterceptor {
        getInternal() {
          return {
            reflector: this.reflector,
            defaultOptions: this.defaultOptions,
          };
        }
      }

      const interceptor = new SubClassSerializer({
        transformerPackage: customTransformer,
      });
      expect(interceptor.getInternal().reflector).toBeInstanceOf(Reflector);
      expect(interceptor.getInternal().defaultOptions.transformerPackage).toBe(
        customTransformer,
      );

      class DummyCtrl {
        get() {}
      }
      const out = await interceptor.intercept(
        makeContext(DummyCtrl, DummyCtrl.prototype.get),
        makeNext({ id: 1 }),
      );
      expect(out).toEqual({ id: 1, transformedBy: "custom" });
      expect(calls).toEqual(["instanceToPlain"]);
    });
  });
});
