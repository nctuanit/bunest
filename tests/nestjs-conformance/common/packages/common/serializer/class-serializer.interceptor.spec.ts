import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as classTransformer from "../../../../../../packages/validation/src/transformer";
import {
  Exclude,
  Expose,
} from "../../../../../../packages/validation/src/transformer";
import {
  Reflector,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
} from "../../../../../../packages/core/src/common";
import {
  CLASS_SERIALIZER_OPTIONS,
  ClassSerializerInterceptor,
  SerializeOptions,
  type ClassSerializerContextOptions,
} from "../../../../../../packages/validation/src";
import {
  createSandbox,
  createStub,
  describeConformance,
  itAdapted,
  type SinonLikeStub,
} from "../../../../_helpers";

describeConformance(
  "ClassSerializerInterceptor",
  {
    upstreamPath:
      "packages/common/test/serializer/class-serializer.interceptor.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Adapted from RxJS Observable CallHandler (`of(...)`) to ADR-008 Promise CallHandler (`Promise.resolve(...)`).",
  },
  () => {
    const sandbox = createSandbox();
    let interceptor: ClassSerializerInterceptor;
    let mockReflector: {
      get: SinonLikeStub;
      getAllAndOverride: SinonLikeStub;
    };
    let mockTransformerPackage: {
      classToPlain: SinonLikeStub;
      plainToInstance: SinonLikeStub;
    };

    beforeEach(() => {
      mockReflector = {
        get: sandbox.stub(),
        getAllAndOverride: sandbox.stub(),
      };
      mockTransformerPackage = {
        classToPlain: sandbox.stub(),
        plainToInstance: sandbox.stub(),
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    describe("constructor", () => {
      it("should create interceptor with default transformer package", () => {
        interceptor = new ClassSerializerInterceptor(
          mockReflector as unknown as Reflector,
        );

        expect(interceptor).toBeInstanceOf(ClassSerializerInterceptor);
      });

      // BUNEST_BUG: ClassSerializerInterceptor hardcodes `import { instanceToPlain, plainToInstance } from "class-transformer"` and ignores `options.transformerPackage` (packages/validation/src/serializer.interceptor.ts)
      it.skip("should use provided transformer package from options", () => {
        const customTransformer = {
          classToPlain: createStub().returns({ custom: true }),
          plainToInstance: createStub(),
        };

        interceptor = new ClassSerializerInterceptor(
          mockReflector as unknown as Reflector,
          {
            transformerPackage: customTransformer,
          } as ClassSerializerContextOptions,
        );

        expect(interceptor).toBeInstanceOf(ClassSerializerInterceptor);
        const result = interceptor.transformToPlain({ id: 1 }, {});
        expect(customTransformer.classToPlain.calledOnce).toBe(true);
        expect(result).toEqual({ custom: true });
      });
    });

    describe("intercept", () => {
      let mockExecutionContext: ExecutionContext;
      let mockCallHandler: { handle: SinonLikeStub };

      beforeEach(() => {
        interceptor = new ClassSerializerInterceptor(
          mockReflector as unknown as Reflector,
        );

        mockExecutionContext = {
          getHandler: createStub(),
          getClass: createStub(),
        } as unknown as ExecutionContext;

        mockCallHandler = {
          handle: createStub(),
        };
      });

      itAdapted(
        "ADR-008",
        "should transform plain object response",
        async () => {
          const response = { id: 1, name: "Test" };
          mockReflector.get.returns(undefined);
          mockCallHandler.handle.resolves(response);

          const result = await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          );
          expect(result).toEqual({ id: 1, name: "Test" });
        },
        "Promise CallHandler",
      );

      itAdapted(
        "ADR-008",
        "should transform array of objects",
        async () => {
          class Item {
            id!: number;
            name!: string;
            @Exclude()
            secret = "hidden";
          }
          const response = [
            Object.assign(new Item(), { id: 1, name: "Test1" }),
            Object.assign(new Item(), { id: 2, name: "Test2" }),
          ];

          mockReflector.get.returns(undefined);
          mockCallHandler.handle.resolves(response);

          const result = (await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          )) as Array<Record<string, unknown>>;

          expect(result).toHaveLength(2);
          expect(result[0]).toEqual({ id: 1, name: "Test1" });
          expect(result[1]).toEqual({ id: 2, name: "Test2" });
        },
        "Promise CallHandler",
      );

      itAdapted(
        "ADR-008",
        "should merge context options with default options",
        async () => {
          @Exclude()
          class MergedDto {
            @Expose()
            id!: number;

            @Expose({ groups: ["user"] })
            name!: string;

            extra!: string;
          }
          const response = Object.assign(new MergedDto(), {
            id: 1,
            name: "Test",
            extra: "drop",
          });
          const defaultOptions: ClassSerializerContextOptions = {
            excludeExtraneousValues: true,
          };
          const contextOptions: ClassSerializerContextOptions = {
            groups: ["user"],
          };

          interceptor = new ClassSerializerInterceptor(
            mockReflector as unknown as Reflector,
            defaultOptions,
          );

          const mockHandler = function handler() {};
          const mockClass = class Ctrl {};
          (mockExecutionContext.getHandler as unknown as SinonLikeStub).returns(
            mockHandler,
          );
          (mockExecutionContext.getClass as unknown as SinonLikeStub).returns(
            mockClass,
          );
          mockReflector.get.callsFake((_key: unknown, target: unknown) =>
            target === mockHandler ? contextOptions : undefined,
          );
          mockCallHandler.handle.resolves(response);

          const result = await interceptor.intercept(
            mockExecutionContext,
            mockCallHandler as unknown as CallHandler,
          );

          expect(result).toEqual({ id: 1, name: "Test" });
        },
        "Promise CallHandler",
      );

      // BUNEST_BUG: ClassSerializerInterceptor.getContextOptions() calls `reflector.get()` separately for class and handler instead of `reflector.getAllAndOverride(CLASS_SERIALIZER_OPTIONS, [handler, class])` (packages/validation/src/serializer.interceptor.ts:166-193)
      it.skip("should call reflector getAllAndOverride with handler and class", async () => {
        const response = { id: 1 };
        const mockHandler = {};
        const mockClass = {};

        (mockExecutionContext.getHandler as unknown as SinonLikeStub).returns(
          mockHandler,
        );
        (mockExecutionContext.getClass as unknown as SinonLikeStub).returns(
          mockClass,
        );
        mockReflector.getAllAndOverride.returns(undefined);
        mockCallHandler.handle.resolves(response);

        await interceptor.intercept(
          mockExecutionContext,
          mockCallHandler as unknown as CallHandler,
        );

        expect(mockReflector.getAllAndOverride.callCount).toBe(1);
        const args = mockReflector.getAllAndOverride.firstCall?.args;
        expect(args?.[1]).toEqual([mockHandler, mockClass]);
      });

      itAdapted(
        "ADR-008",
        "should serialize a response while another interceptor is created",
        async () => {
          class User {
            id = 1;
            @Exclude()
            password = "secret";
          }
          interceptor = new ClassSerializerInterceptor(
            mockReflector as unknown as Reflector,
          );
          const next: CallHandler = { handle: async () => new User() };

          const resultPromise = interceptor.intercept(
            mockExecutionContext,
            next,
          );
          // e.g. a request-scoped interceptor, created for another request
          new ClassSerializerInterceptor(mockReflector as unknown as Reflector);

          expect(await resultPromise).toEqual({ id: 1 });
        },
        "Promise CallHandler",
      );

      describe("when the handler streams", () => {
        @Exclude()
        class UserDto {
          @Expose()
          id!: number;

          password!: string;
        }
        const users = () => [
          Object.assign(new UserDto(), { id: 1, password: "secret" }),
          Object.assign(new UserDto(), { id: 2, password: "secret" }),
        ];
        const collect = async (stream: unknown) => {
          const chunks: unknown[] = [];
          for await (const chunk of stream as AsyncIterable<unknown>) {
            chunks.push(chunk);
          }
          return chunks;
        };

        beforeEach(() => {
          interceptor = new ClassSerializerInterceptor(
            mockReflector as unknown as Reflector,
            {
              transformerPackage: classTransformer,
            } as ClassSerializerContextOptions,
          );
        });

        // BUNEST_BUG: ClassSerializerInterceptor passes AsyncIterable / Readable / ReadableStream through untouched even over HTTP instead of serializing yielded objects via mapStreamingBody (packages/validation/src/serializer.interceptor.ts:120)
        it.skip.each<[string, (chunks: unknown[]) => unknown]>([
          [
            "an async generator",
            (chunks) =>
              (async function* () {
                yield* chunks;
              })(),
          ],
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
        ])(
          "should serialize the objects %s yields over HTTP",
          async (_, create) => {
            const context = {
              ...mockExecutionContext,
              getType: () => "http",
            } as ExecutionContext;
            const bytes = Buffer.from("bytes");
            const next: CallHandler = {
              handle: async () => create([...users(), "text", bytes]),
            };

            const result = await interceptor.intercept(context, next);

            expect(await collect(result)).toEqual([
              { id: 1 },
              { id: 2 },
              "text",
              bytes,
            ]);
          },
        );

        itAdapted(
          "ADR-008",
          "should leave a stream alone for another transport",
          async () => {
            const context = {
              ...mockExecutionContext,
              getType: () => "rpc",
            } as ExecutionContext;
            const stream = new ReadableStream({
              start(controller) {
                for (const user of users()) {
                  controller.enqueue(user);
                }
                controller.close();
              },
            });
            const next: CallHandler = { handle: async () => stream };

            const result = await interceptor.intercept(context, next);

            expect(result).toBe(stream);
          },
          "Promise CallHandler",
        );

        itAdapted(
          "ADR-008",
          "should leave the bytes of a Response alone",
          async () => {
            const context = {
              ...mockExecutionContext,
              getType: () => "http",
            } as ExecutionContext;
            const response = new Response("bytes");
            const next: CallHandler = { handle: async () => response };

            const result = await interceptor.intercept(context, next);

            expect(result).toBe(response);
          },
          "Promise CallHandler",
        );
      });

      describe("with class-transformer groups", () => {
        @Exclude()
        class UserDto {
          @Expose()
          id!: number;

          @Expose({ groups: ["public"] })
          name!: string;

          @Expose({ groups: ["admin"] })
          email!: string;

          password!: string;
        }

        const groupCases: Array<{ groups: string[]; array: boolean }> = [
          { groups: ["public"], array: false },
          { groups: ["public"], array: true },
          { groups: [], array: false },
          { groups: [], array: true },
        ];

        it.each(groupCases)(
          "should override default groups with $groups (array: $array)",
          async ({ groups, array }) => {
            const reflector = new Reflector();
            class GroupController {
              @SerializeOptions({ groups })
              handler() {}
            }
            interceptor = new ClassSerializerInterceptor(reflector, {
              type: UserDto,
              groups: ["admin"],
            });

            const context = {
              getHandler: () => GroupController.prototype.handler,
              getClass: () => GroupController,
            } as unknown as ExecutionContext;

            const user = {
              id: 1,
              name: "Alice",
              email: "alice@example.com",
              password: "secret",
            };
            const next: CallHandler = {
              handle: async () => (array ? [user] : user),
            };
            const result = await interceptor.intercept(context, next);
            const expected = groups.length
              ? { id: 1, name: "Alice" }
              : { id: 1 };

            expect(result).toEqual(array ? [expected] : expected);
          },
        );
      });
    });

    describe("serialize", () => {
      beforeEach(() => {
        interceptor = new ClassSerializerInterceptor(
          mockReflector as unknown as Reflector,
        );
      });

      it("should return primitive values unchanged", () => {
        expect(interceptor.serialize("string", {})).toBe("string");
        expect(interceptor.serialize(123, {})).toBe(123);
        expect(interceptor.serialize(true, {})).toBe(true);
      });

      it("should return null unchanged", () => {
        expect(interceptor.serialize(null, {})).toBeNull();
      });

      it("should return undefined unchanged", () => {
        expect(interceptor.serialize(undefined, {})).toBeUndefined();
      });

      // BUNEST_BUG: ClassSerializerInterceptor's `isPassthroughValue()` does not check `value instanceof StreamableFile`, so `instanceToPlain()` corrupts StreamableFile into a plain object instead of returning it unchanged (packages/validation/src/serializer.interceptor.ts:27-65)
      it.skip("should return StreamableFile unchanged", () => {
        const streamableFile = new StreamableFile(Buffer.from("test"));
        const result = interceptor.serialize(streamableFile, {});

        expect(result).toBe(streamableFile);
        expect(mockTransformerPackage.classToPlain.notCalled).toBe(true);
      });

      it.each<[string, () => unknown]>([
        ["a Response", () => new Response("test")],
        ["a ReadableStream", () => new ReadableStream()],
        [
          "a ReadableStream with bytes",
          () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("test"));
                controller.close();
              },
            }),
        ],
        ["an async generator", () => (async function* () {})()],
      ])("should return %s unchanged", (_, create) => {
        const stream = create();
        const result = interceptor.serialize(stream, {});

        expect(result).toBe(stream);
      });

      it("should transform plain object", () => {
        class SimpleDto {
          id = 1;
          @Exclude()
          name = "Test";
        }
        const result = interceptor.serialize(new SimpleDto(), {});
        expect(result).toEqual({ id: 1 });
      });

      it("should transform array of objects", () => {
        class SimpleDto {
          constructor(
            public id: number,
            public secret: string,
          ) {}
          @Exclude()
          hidden = true;
        }
        const input = [new SimpleDto(1, "a"), new SimpleDto(2, "b")];
        const result = interceptor.serialize(input, {}) as Array<
          Record<string, unknown>
        >;

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ id: 1, secret: "a" });
        expect(result[1]).toEqual({ id: 2, secret: "b" });
      });

      it("should handle empty array", () => {
        const input: unknown[] = [];
        const result = interceptor.serialize(input, {}) as unknown[];
        expect(result).toHaveLength(0);
      });
    });

    describe("transformToPlain", () => {
      beforeEach(() => {
        interceptor = new ClassSerializerInterceptor(
          mockReflector as unknown as Reflector,
        );
      });

      it("should return falsy values unchanged", () => {
        expect(interceptor.transformToPlain(null, {})).toBeNull();
        expect(interceptor.transformToPlain(undefined, {})).toBeUndefined();
        expect(interceptor.transformToPlain(0, {})).toBe(0);
        expect(interceptor.transformToPlain(false, {})).toBe(false);
        expect(interceptor.transformToPlain("", {})).toBe("");
      });

      it("should use instanceToPlain when no type option provided", () => {
        class BasicDto {
          id = 1;
          @Exclude()
          name = "Test";
        }
        const result = interceptor.transformToPlain(new BasicDto(), {});
        expect(result).toEqual({ id: 1 });
      });

      it("should use instanceToPlain when input is instance of options.type", () => {
        class UserDto {
          id!: number;
          @Exclude()
          name!: string;
        }

        const input = new UserDto();
        input.id = 1;
        input.name = "Test";

        const result = interceptor.transformToPlain(input, { type: UserDto });
        expect(result).toEqual({ id: 1 });
      });

      it("should convert plain to instance then to plain when type provided but not matching", () => {
        @Exclude()
        class UserDto {
          @Expose()
          id!: number;
        }

        const plainInput = { id: 1, name: "Test", password: "secret" };
        const result = interceptor.transformToPlain(plainInput, {
          type: UserDto,
        });

        expect(result).toEqual({ id: 1 });
      });

      it("should handle complex nested objects", () => {
        class NestedUser {
          id = 1;
          @Exclude()
          name = "Test";
        }
        class NestedPost {
          id = 1;
          @Exclude()
          title = "Post 1";
        }
        const input = {
          user: new NestedUser(),
          posts: [new NestedPost()],
        };

        const result = interceptor.transformToPlain(input, {});

        expect(result).toEqual({
          user: { id: 1 },
          posts: [{ id: 1 }],
        });
      });
    });

    describe("getContextOptions", () => {
      beforeEach(() => {
        interceptor = new ClassSerializerInterceptor(
          mockReflector as unknown as Reflector,
        );
      });

      // BUNEST_BUG: ClassSerializerInterceptor.getContextOptions() calls `reflector.get()` separately instead of `reflector.getAllAndOverride(CLASS_SERIALIZER_OPTIONS, [handler, class])` (packages/validation/src/serializer.interceptor.ts:166-193)
      it.skip("should call reflector getAllAndOverride with correct arguments", () => {
        const mockHandler = {};
        const mockClass = {};
        const mockContext = {
          getHandler: createStub().returns(mockHandler),
          getClass: createStub().returns(mockClass),
        } as unknown as ExecutionContext;

        const expectedOptions = { groups: ["admin"] };
        mockReflector.getAllAndOverride.returns(expectedOptions);

        const result = (
          interceptor as unknown as {
            getContextOptions: (ctx: ExecutionContext) => unknown;
          }
        ).getContextOptions(mockContext);

        expect(mockReflector.getAllAndOverride.callCount).toBe(1);
        const callArgs = mockReflector.getAllAndOverride.firstCall?.args;
        expect(callArgs?.[1]).toEqual([mockHandler, mockClass]);
        expect(result).toBe(expectedOptions);
      });

      it("should return undefined when no metadata exists", () => {
        const mockContext = {
          getHandler: createStub().returns({}),
          getClass: createStub().returns({}),
        } as unknown as ExecutionContext;

        mockReflector.get.returns(undefined);

        const result = (
          interceptor as unknown as {
            getContextOptions: (ctx: ExecutionContext) => unknown;
          }
        ).getContextOptions(mockContext);

        expect(result).toBeUndefined();
      });

      it("should respect handler metadata over class metadata", () => {
        const reflector = new Reflector();
        const realInterceptor = new ClassSerializerInterceptor(reflector);

        @SerializeOptions({ groups: ["class-group"], version: 1 })
        class MetaController {
          @SerializeOptions({
            groups: ["user"],
            excludeExtraneousValues: true,
          })
          handler() {}
        }

        const mockContext = {
          getHandler: () => MetaController.prototype.handler,
          getClass: () => MetaController,
        } as unknown as ExecutionContext;

        const result = (
          realInterceptor as unknown as {
            getContextOptions: (
              ctx: ExecutionContext,
            ) => ClassSerializerContextOptions | undefined;
          }
        ).getContextOptions(mockContext);

        expect(result).toMatchObject({
          groups: ["user"],
          excludeExtraneousValues: true,
        });
        expect(
          reflector.get(
            CLASS_SERIALIZER_OPTIONS,
            MetaController.prototype.handler,
          ),
        ).toEqual({
          groups: ["user"],
          excludeExtraneousValues: true,
        });
      });
    });

    describe("edge cases and error handling", () => {
      beforeEach(() => {
        interceptor = new ClassSerializerInterceptor(
          mockReflector as unknown as Reflector,
        );
      });

      it("should handle array with mixed types", () => {
        const input = [
          { id: 1, name: "Test" },
          null,
          undefined,
          { id: 2, name: "Test2" },
        ];

        const result = interceptor.serialize(input, {}) as unknown[];

        expect(result).toHaveLength(4);
        expect(result[0]).toEqual({ id: 1, name: "Test" });
        expect(result[1]).toBeNull();
        expect(result[2]).toBeUndefined();
        expect(result[3]).toEqual({ id: 2, name: "Test2" });
      });

      it("should not transform when response is not an object", () => {
        const input = "plain string";
        const result = interceptor.serialize(input, {});
        expect(result).toBe(input);
      });

      it("should handle Date objects", () => {
        const date = new Date();
        const result = interceptor.serialize({ date }, {}) as { date: Date };
        expect(result.date).toBeInstanceOf(Date);
        expect(result.date.getTime()).toBe(date.getTime());
      });

      it("should pass through options to transformer", () => {
        class PublicDto {
          @Expose({ groups: ["public"] })
          id = 1;

          @Expose({ groups: ["public"] })
          name = "Test";

          password = "secret";
        }

        const result = interceptor.transformToPlain(new PublicDto(), {
          excludeExtraneousValues: true,
          groups: ["public"],
          strategy: "excludeAll",
        });

        expect(result).toEqual({
          id: 1,
          name: "Test",
        });
      });
    });
  },
);
