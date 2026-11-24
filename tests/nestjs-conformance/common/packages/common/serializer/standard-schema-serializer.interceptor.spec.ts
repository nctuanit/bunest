import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  HttpException,
  HttpStatus,
  Reflector,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type StandardSchemaV1,
  type StandardSchemaV1Options,
  type StandardSchemaV1Result,
  type ValidationErrorResponse,
} from "../../../../../../packages/core/src/common";
import {
  StandardSchemaSerializerInterceptor,
  UseStandardSchema,
  type StandardSchemaSerializerInterceptorOptions,
} from "../../../../../../packages/validation/src";
import {
  createSandbox,
  createSpy,
  createStub,
  describeConformance,
  itAdapted,
  type SinonLikeStub,
} from "../../../../_helpers";

function createSchema(
  validateFn: (
    value: unknown,
    options?: StandardSchemaV1Options,
  ) => StandardSchemaV1Result<any> | Promise<StandardSchemaV1Result<any>>,
): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: validateFn,
    },
  };
}

describeConformance(
  "StandardSchemaSerializerInterceptor",
  {
    upstreamPath:
      "packages/common/test/serializer/standard-schema-serializer.interceptor.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008", "ADR-009"],
    notes:
      "Adapted from RxJS Observable CallHandler to ADR-008 single-value Promise CallHandler and ADR-009 normalized validation error envelope.",
  },
  () => {
    const sandbox = createSandbox();
    let interceptor: StandardSchemaSerializerInterceptor;
    let mockReflector: {
      get: SinonLikeStub;
      getAll: SinonLikeStub;
    };
    let mockExecutionContext: ExecutionContext;
    let mockCallHandler: { handle: SinonLikeStub };

    beforeEach(() => {
      mockReflector = {
        get: sandbox.stub().returns(undefined),
        getAll: sandbox.stub().returns([undefined, undefined]),
      };

      mockExecutionContext = {
        getHandler: sandbox.stub(),
        getClass: sandbox.stub(),
      } as unknown as ExecutionContext;

      mockCallHandler = {
        handle: sandbox.stub(),
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    describe("intercept", () => {
      describe("when no schema is provided", () => {
        itAdapted(
          "ADR-008",
          "should return the response unchanged",
          async () => {
            interceptor = new StandardSchemaSerializerInterceptor(
              mockReflector as unknown as Reflector,
            );
            const response = { id: 1, name: "Test" };
            mockCallHandler.handle.resolves(response);

            const result = await interceptor.intercept(
              mockExecutionContext,
              mockCallHandler as unknown as CallHandler,
            );
            expect(result).toBe(response);
          },
          "Promise CallHandler",
        );
      });

      describe("when schema is provided via default options", () => {
        itAdapted(
          "ADR-008",
          "should serialize the response through the schema",
          async () => {
            const schema = createSchema((value) => ({
              value: {
                ...(value as Record<string, unknown>),
                serialized: true,
              },
            }));
            interceptor = new StandardSchemaSerializerInterceptor(
              mockReflector as unknown as Reflector,
              { schema },
            );
            const response = { id: 1, name: "Test" };
            mockCallHandler.handle.resolves(response);

            const result = await interceptor.intercept(
              mockExecutionContext,
              mockCallHandler as unknown as CallHandler,
            );
            expect(result).toEqual({ id: 1, name: "Test", serialized: true });
          },
          "Promise CallHandler",
        );
      });

      describe("when schema is provided via decorator (@UseStandardSchema / @SerializeOptions)", () => {
        itAdapted(
          "ADR-008",
          "should use the context schema over the default",
          async () => {
            const defaultSchema = createSchema((value) => ({
              value: {
                ...(value as Record<string, unknown>),
                fromDefault: true,
              },
            }));
            const contextSchema = createSchema((value) => ({
              value: {
                ...(value as Record<string, unknown>),
                fromContext: true,
              },
            }));

            class DemoController {
              @UseStandardSchema(contextSchema)
              handler() {}
            }

            interceptor = new StandardSchemaSerializerInterceptor(
              new Reflector(),
              { schema: defaultSchema },
            );
            const context = {
              getHandler: () => DemoController.prototype.handler,
              getClass: () => DemoController,
            } as unknown as ExecutionContext;
            const response = { id: 1 };
            mockCallHandler.handle.resolves(response);

            const result = await interceptor.intercept(
              context,
              mockCallHandler as unknown as CallHandler,
            );
            expect(result).toEqual({ id: 1, fromContext: true });
          },
          "Promise CallHandler + @UseStandardSchema",
        );

        it("should keep the class schema when the handler only sets validateOptions", async () => {
          const validateSpy = createSpy((value: any) => ({
            value: { id: value.id },
          }));
          const classSchema = createSchema(validateSpy);
          const handlerOpts: StandardSchemaV1Options = {
            libraryOptions: { from: "handler" },
          };
          interceptor = new StandardSchemaSerializerInterceptor(
            mockReflector as unknown as Reflector,
          );
          mockReflector.getAll.returns([
            { validateOptions: handlerOpts },
            { schema: classSchema },
          ]);
          const response = { id: 1, password: "secret" };
          mockCallHandler.handle.resolves(response);

          const result = await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          );
          expect(result).toEqual({ id: 1 });
          expect(validateSpy).toHaveBeenCalledWith(response, handlerOpts);
        });

        it("should use the handler schema with the class validateOptions", async () => {
          const classSchema = createSchema((value) => ({
            value: { ...(value as Record<string, unknown>), fromClass: true },
          }));
          const validateSpy = createSpy((value: any) => ({
            value: { ...value, fromHandler: true },
          }));
          const classOpts: StandardSchemaV1Options = {
            libraryOptions: { from: "class" },
          };
          interceptor = new StandardSchemaSerializerInterceptor(
            mockReflector as unknown as Reflector,
          );
          mockReflector.getAll.returns([
            { schema: createSchema(validateSpy) },
            { schema: classSchema, validateOptions: classOpts },
          ]);
          const response = { id: 1 };
          mockCallHandler.handle.resolves(response);

          const result = await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          );
          expect(result).toEqual({
            id: 1,
            fromHandler: true,
          });
          expect(validateSpy).toHaveBeenCalledWith(response, classOpts);
        });
      });

      describe("when response is an array", () => {
        it("should serialize each item through the schema", async () => {
          const schema = createSchema((value) => ({
            value: { ...(value as Record<string, unknown>), serialized: true },
          }));
          interceptor = new StandardSchemaSerializerInterceptor(
            mockReflector as unknown as Reflector,
            { schema },
          );
          const response = [{ id: 1 }, { id: 2 }];
          mockCallHandler.handle.resolves(response);

          const result = await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          );
          expect(result).toEqual([
            { id: 1, serialized: true },
            { id: 2, serialized: true },
          ]);
        });
      });

      describe("when response is not an object", () => {
        it("should return primitive values unchanged", async () => {
          const schema = createSchema(() => ({
            issues: [{ message: "should not be called" }],
          }));
          interceptor = new StandardSchemaSerializerInterceptor(
            mockReflector as unknown as Reflector,
            { schema },
          );
          mockCallHandler.handle.resolves("plain string");

          const result = await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          );
          expect(result).toBe("plain string");
        });
      });

      describe("when response is a stream", () => {
        it.each<[string, () => unknown]>([
          ["a Response", () => new Response("test")],
          ["a ReadableStream", () => new ReadableStream()],
          ["an async generator", () => (async function* () {})()],
        ])("should return %s unchanged", async (_, create) => {
          const schema = createSchema(() => ({
            issues: [{ message: "should not be called" }],
          }));
          interceptor = new StandardSchemaSerializerInterceptor(
            mockReflector as unknown as Reflector,
            { schema },
          );
          const stream = create();
          mockCallHandler.handle.resolves(stream);

          const result = await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          );

          expect(result).toBe(stream);
        });
      });

      describe("when the handler streams over HTTP", () => {
        const collect = async (stream: unknown) => {
          const chunks: unknown[] = [];
          for await (const chunk of stream as AsyncIterable<unknown>) {
            chunks.push(chunk);
          }
          return chunks;
        };

        beforeEach(() => {
          (
            mockExecutionContext as unknown as { getType: () => string }
          ).getType = () => "http";
        });

        it.each<[string, (chunks: unknown[]) => unknown]>([
          [
            "a ReadableStream in object mode",
            (chunks) =>
              new ReadableStream({
                start(controller) {
                  for (const chunk of chunks) {
                    controller.enqueue(chunk);
                  }
                  controller.close();
                },
              }),
          ],
          [
            "a ReadableStream",
            (chunks) =>
              new ReadableStream({
                start(controller) {
                  for (const chunk of chunks) {
                    controller.enqueue(chunk);
                  }
                  controller.close();
                },
              }),
          ],
          [
            "an async generator",
            (chunks) =>
              (async function* () {
                yield* chunks;
              })(),
          ],
        ])("should serialize the objects %s yields", async (_, create) => {
          const validateOptions = { libraryOptions: { strip: true } };
          const validate = createSpy((value: any) => ({
            value: { id: value.id },
          }));
          interceptor = new StandardSchemaSerializerInterceptor(
            mockReflector as unknown as Reflector,
            {
              schema: createSchema(validate),
              validateOptions,
            } as StandardSchemaSerializerInterceptorOptions,
          );
          const entity = { id: 1, password: "secret" };
          const bytes = Buffer.from("bytes");
          mockCallHandler.handle.resolves(
            create([entity, [entity], "text", bytes]),
          );

          const result = await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          );

          expect(await collect(result)).toEqual([
            { id: 1 },
            [{ id: 1 }],
            "text",
            bytes,
          ]);
          expect(validate).toHaveBeenCalledWith(entity, validateOptions);
        });

        it("should fail the stream with the issues of an object it yields", async () => {
          interceptor = new StandardSchemaSerializerInterceptor(
            mockReflector as unknown as Reflector,
            {
              schema: createSchema(() => ({
                issues: [{ message: "id is required" }],
              })),
            },
          );
          mockCallHandler.handle.resolves(
            (async function* () {
              yield { password: "secret" };
            })(),
          );

          const result = await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          );

          await expect(
            (result as AsyncIterator<unknown>).next(),
          ).rejects.toThrow("Serialization failed: id is required");
        });

        itAdapted(
          "ADR-008",
          "should leave a stream alone without a schema",
          async () => {
            interceptor = new StandardSchemaSerializerInterceptor(
              mockReflector as unknown as Reflector,
            );
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue({ id: 1 });
                controller.close();
              },
            });
            mockCallHandler.handle.resolves(stream);

            const result = await interceptor.intercept(
              mockExecutionContext,
              mockCallHandler as unknown as CallHandler,
            );

            expect(result).toBe(stream);
          },
        );
      });

      describe("when response is a StreamableFile", () => {
        itAdapted(
          "ADR-008",
          "should return the streamable file unchanged",
          async () => {
            const schema = createSchema(() => ({
              issues: [{ message: "should not be called" }],
            }));
            interceptor = new StandardSchemaSerializerInterceptor(
              mockReflector as unknown as Reflector,
              { schema },
            );
            const file = new StreamableFile(Buffer.from("test"));
            mockCallHandler.handle.resolves(file);

            const result = await interceptor.intercept(
              mockExecutionContext,
              mockCallHandler as unknown as CallHandler,
            );
            expect(result).toBe(file);
          },
        );
      });

      describe("when schema validation fails", () => {
        itAdapted(
          "ADR-009",
          "should throw an HTTP 500 error containing all issue messages",
          async () => {
            const schema = createSchema(() => ({
              issues: [
                { message: "field is required" },
                { message: "must be a number" },
              ],
            }));
            interceptor = new StandardSchemaSerializerInterceptor(
              mockReflector as unknown as Reflector,
              { schema },
            );
            const response = { id: 1 };
            mockCallHandler.handle.resolves(response);

            let caught: unknown;
            try {
              await interceptor.intercept(
                mockExecutionContext,
                mockCallHandler as unknown as CallHandler,
              );
            } catch (err) {
              caught = err;
            }

            expect(caught).toBeInstanceOf(HttpException);
            const httpErr = caught as HttpException;
            expect(httpErr.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
            const body = httpErr.toJSON() as unknown as ValidationErrorResponse;
            const allMessages = body.details.flatMap((d) => d.messages);
            expect(allMessages).toEqual([
              "field is required",
              "must be a number",
            ]);
          },
          "normalized HttpException(500) details envelope",
        );
      });

      describe("when async schema is used", () => {
        itAdapted(
          "ADR-008",
          "should resolve the async validation result",
          async () => {
            const schema = createSchema(async (value) => ({
              value: { ...(value as Record<string, unknown>), async: true },
            }));
            interceptor = new StandardSchemaSerializerInterceptor(
              mockReflector as unknown as Reflector,
              { schema },
            );
            const response = { id: 1 };
            mockCallHandler.handle.resolves(response);

            const result = await interceptor.intercept(
              mockExecutionContext,
              mockCallHandler as unknown as CallHandler,
            );
            expect(result).toEqual({ id: 1, async: true });
          },
        );
      });
    });

    describe("when the handler runs across multiple sequential values [ADR-008: Promise CallHandler]", () => {
      const schema = createSchema((value) => ({
        value: { id: (value as { id: number }).id },
      }));

      beforeEach(() => {
        interceptor = new StandardSchemaSerializerInterceptor(
          mockReflector as unknown as Reflector,
          { schema },
        );
      });

      itAdapted(
        "ADR-008",
        "should serialize sequential Promise responses in order",
        async () => {
          const values = Array.from({ length: 3 }, (_, id) => ({
            id,
            secret: "x",
          }));

          const results: unknown[] = [];
          for (const val of values) {
            const next: CallHandler = { handle: async () => val };
            results.push(
              await interceptor.intercept(mockExecutionContext, next),
            );
          }

          expect(results).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
        },
        "single-value Promise instead of RxJS Observable stream",
      );

      itAdapted(
        "ADR-008",
        "should await async validation before resolving each invocation",
        async () => {
          const pending: Array<() => void> = [];
          const validate = createSpy(
            (value: unknown) =>
              new Promise<StandardSchemaV1Result<unknown>>((resolve) =>
                pending.push(() => resolve({ value })),
              ),
          );
          interceptor = new StandardSchemaSerializerInterceptor(
            mockReflector as unknown as Reflector,
            { schema: createSchema(validate) },
          );

          const p1 = interceptor.intercept(mockExecutionContext, {
            handle: async () => ({ id: 1 }),
          });
          await Promise.resolve();
          expect(validate.callCount).toBe(1);

          pending.shift()!();
          expect(await p1).toEqual({ id: 1 });

          const p2 = interceptor.intercept(mockExecutionContext, {
            handle: async () => ({ id: 2 }),
          });
          await Promise.resolve();
          expect(validate.callCount).toBe(2);

          pending.shift()!();
          expect(await p2).toEqual({ id: 2 });
        },
        "Promise CallHandler instead of RxJS Subject",
      );

      itAdapted(
        ["ADR-008", "ADR-009"],
        "should fail on the first invalid response when invoked sequentially",
        async () => {
          const validate = createSpy((value: unknown) =>
            (value as { id: number }).id === 1
              ? { issues: [{ message: "Invalid" }] }
              : { value },
          );
          interceptor = new StandardSchemaSerializerInterceptor(
            mockReflector as unknown as Reflector,
            { schema: createSchema(validate) },
          );

          const items = [{ id: 0 }, { id: 1 }, { id: 2 }];
          await expect(
            (async () => {
              for (const item of items) {
                await interceptor.intercept(mockExecutionContext, {
                  handle: async () => item,
                });
              }
            })(),
          ).rejects.toThrow(HttpException);
          expect(validate.callCount).toBe(2);
        },
      );
    });

    describe("transformToPlain", () => {
      it("should return falsy values as-is", async () => {
        interceptor = new StandardSchemaSerializerInterceptor(
          mockReflector as unknown as Reflector,
        );
        const schema = createSchema(() => ({
          issues: [{ message: "should not be called" }],
        }));
        const withTransform = interceptor as unknown as {
          transformToPlain: (
            value: unknown,
            s: StandardSchemaV1,
          ) => Promise<unknown>;
        };
        expect(await withTransform.transformToPlain(null, schema)).toBeNull();
        expect(
          await withTransform.transformToPlain(undefined, schema),
        ).toBeUndefined();
        expect(await withTransform.transformToPlain(0, schema)).toBe(0);
        expect(await withTransform.transformToPlain("", schema)).toBe("");
      });
    });

    describe("validateOptions", () => {
      it("should forward default validateOptions to the schema", async () => {
        const validateSpy = createSpy(
          (_value: unknown, _options?: unknown) => ({
            value: { ok: true },
          }),
        );
        const schema = createSchema(validateSpy);
        const opts: StandardSchemaV1Options = {
          libraryOptions: { strip: true },
        };
        interceptor = new StandardSchemaSerializerInterceptor(
          mockReflector as unknown as Reflector,
          {
            schema,
            validateOptions: opts,
          } as StandardSchemaSerializerInterceptorOptions,
        );
        const response = { id: 1 };
        mockCallHandler.handle.resolves(response);

        await interceptor.intercept(
          mockExecutionContext,
          mockCallHandler as unknown as CallHandler,
        );
        expect(validateSpy).toHaveBeenCalledWith(response, opts);
      });

      it("should forward context validateOptions from @SerializeOptions()", async () => {
        const validateSpy = createSpy(
          (_value: unknown, _options?: unknown) => ({
            value: { ok: true },
          }),
        );
        const schema = createSchema(validateSpy);
        const contextOpts: StandardSchemaV1Options = {
          libraryOptions: { mode: "strict" },
        };
        interceptor = new StandardSchemaSerializerInterceptor(
          mockReflector as unknown as Reflector,
          { schema },
        );
        mockReflector.getAll.returns([
          { validateOptions: contextOpts },
          undefined,
        ]);
        const response = { id: 1 };
        mockCallHandler.handle.resolves(response);

        await interceptor.intercept(
          mockExecutionContext,
          mockCallHandler as unknown as CallHandler,
        );
        expect(validateSpy).toHaveBeenCalledWith(response, contextOpts);
      });

      it("should let context validateOptions override default", async () => {
        const validateSpy = createSpy(
          (_value: unknown, _options?: unknown) => ({
            value: { ok: true },
          }),
        );
        const schema = createSchema(validateSpy);
        const defaultOpts: StandardSchemaV1Options = {
          libraryOptions: { from: "default" },
        };
        const contextOpts: StandardSchemaV1Options = {
          libraryOptions: { from: "context" },
        };
        interceptor = new StandardSchemaSerializerInterceptor(
          mockReflector as unknown as Reflector,
          {
            schema,
            validateOptions: defaultOpts,
          } as StandardSchemaSerializerInterceptorOptions,
        );
        mockReflector.getAll.returns([
          { validateOptions: contextOpts },
          undefined,
        ]);
        const response = { id: 1 };
        mockCallHandler.handle.resolves(response);

        await interceptor.intercept(
          mockExecutionContext,
          mockCallHandler as unknown as CallHandler,
        );
        expect(validateSpy).toHaveBeenCalledWith(response, contextOpts);
      });

      it("should pass undefined when no validateOptions are set", async () => {
        const validateSpy = createSpy(
          (_value: unknown, _options?: unknown) => ({
            value: { ok: true },
          }),
        );
        const schema = createSchema(validateSpy);
        interceptor = new StandardSchemaSerializerInterceptor(
          mockReflector as unknown as Reflector,
          { schema },
        );
        const response = { id: 1 };
        mockCallHandler.handle.resolves(response);

        await interceptor.intercept(
          mockExecutionContext,
          mockCallHandler as unknown as CallHandler,
        );
        expect(validateSpy).toHaveBeenCalledWith(response, undefined);
      });
    });
  },
);
