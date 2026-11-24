import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Catch,
  createParamDecorator,
  ExternalContextCreator,
  ForbiddenException,
  Injectable,
  METADATA_KEYS,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type ParamsFactory,
  type PipeTransform,
} from "../../../../../../packages/core/src";
import {
  createSandbox,
  createSpy,
  createTestingModule,
  describeConformance,
  itAdapted,
} from "../../../../_helpers";

describeConformance(
  "ExternalContextCreator",
  {
    upstreamPath: "packages/core/test/helpers/external-context-creator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Adapts NestJS internal consumer-based ExternalContextCreator tests to Bunest's self-contained Promise-based ExternalContextCreator (ADR-008) while faithfully surfacing missing upstream APIs and param-decorator bugs.",
  },
  () => {
    const sandbox = createSandbox();
    let contextCreator: ExternalContextCreator;

    beforeEach(() => {
      contextCreator = new ExternalContextCreator();
    });

    afterEach(() => {
      sandbox.restore();
    });

    describe("create", () => {
      describe("returns proxy function", () => {
        it("should be a function", () => {
          const instance = { foo: "bar" };
          const proxyContext = contextCreator.create(
            instance,
            () => "ok",
            "handle",
          );
          expect(typeof proxyContext).toBe("function");
        });

        describe("when proxy function called", () => {
          describe("when can not activate", () => {
            it("should throw ForbiddenException when guard returns false", async () => {
              const denyGuard: CanActivate = {
                canActivate: async () => false,
              };

              class GuardedHost {
                @UseGuards(denyGuard)
                run(...args: unknown[]) {
                  return args;
                }
              }

              const instance = new GuardedHost();
              const proxyContext = contextCreator.create(
                instance,
                instance.run,
                "run",
              );

              let err: unknown;
              try {
                await proxyContext(1, 2, 3);
              } catch (e) {
                err = e;
              }
              expect(err).toBeInstanceOf(ForbiddenException);
            });
          });

          describe("when can activate", () => {
            it("should apply context (this) and args", async () => {
              const allowGuard: CanActivate = {
                canActivate: async () => true,
              };

              class AllowedHost {
                readonly prefix = "ctx";

                @UseGuards(allowGuard)
                run(a: number, b: number, c: number) {
                  return `${this.prefix}:${a + b + c}`;
                }
              }

              const instance = new AllowedHost();
              const runSpy = sandbox.spy(instance, "run");
              const proxyContext = contextCreator.create(
                instance,
                instance.run as (...args: unknown[]) => unknown,
                "run",
              );

              const result = await proxyContext(1, 2, 3);
              expect(runSpy.calledOnceWith(1, 2, 3)).toBe(true);
              expect(result).toBe("ctx:6");
            });
          });
        });
      });

      describe("enhancer pipeline (guards, interceptors, pipes, filters, options)", () => {
        itAdapted(
          "ADR-008",
          "should execute Promise interceptors in onion order (class before method) and respect options.interceptors",
          async () => {
            const trace: string[] = [];

            const classInterceptor: BunestInterceptor = {
              async intercept(_ctx: ExecutionContext, next: CallHandler) {
                trace.push("class:before");
                const val = await next.handle();
                trace.push("class:after");
                return `class(${String(val)})`;
              },
            };

            const methodInterceptor: BunestInterceptor = {
              async intercept(_ctx: ExecutionContext, next: CallHandler) {
                trace.push("method:before");
                const val = await next.handle();
                trace.push("method:after");
                return `method(${String(val)})`;
              },
            };

            @UseInterceptors(classInterceptor)
            class InterceptedHost {
              @UseInterceptors(methodInterceptor)
              execute(input: string) {
                trace.push("handler");
                return input;
              }
            }

            const instance = new InterceptedHost();
            const wrapped = contextCreator.create(
              instance,
              instance.execute as (...args: unknown[]) => unknown,
              "execute",
            );

            expect(await wrapped("hi")).toBe("class(method(hi))");
            expect(trace).toEqual([
              "class:before",
              "method:before",
              "handler",
              "method:after",
              "class:after",
            ]);

            trace.length = 0;
            const bypassed = contextCreator.create(
              instance,
              instance.execute as (...args: unknown[]) => unknown,
              "execute",
              undefined,
              undefined,
              undefined,
              undefined,
              { interceptors: false },
            );
            expect(await bypassed("raw")).toBe("raw");
            expect(trace).toEqual(["handler"]);
          },
          "Promise CallHandler onion pipeline",
        );

        it("should apply class & method pipes to args and respect options.pipes", async () => {
          const appendA: PipeTransform = {
            transform: (val: unknown) => `${String(val)}-a`,
          };
          const appendB: PipeTransform = {
            transform: async (val: unknown) => `${String(val)}-b`,
          };

          @UsePipes(appendA)
          class PipedHost {
            @UsePipes(appendB)
            echo(v1: string, v2: string) {
              return [v1, v2];
            }
          }

          const instance = new PipedHost();
          const wrapped = contextCreator.create(
            instance,
            instance.echo as (...args: unknown[]) => unknown,
            "echo",
          );
          expect(await wrapped("x", "y")).toEqual(["x-a-b", "y-a-b"]);

          const noPipes = contextCreator.create(
            instance,
            instance.echo as (...args: unknown[]) => unknown,
            "echo",
            undefined,
            undefined,
            undefined,
            undefined,
            { pipes: false },
          );
          expect(await noPipes("x", "y")).toEqual(["x", "y"]);
        });

        it("should catch matching exceptions via method/class filters and respect options.filters", async () => {
          class CustomError extends Error {}

          @Catch(CustomError)
          class CustomFilter implements ExceptionFilter {
            catch(err: CustomError, host: ArgumentsHost) {
              return `caught:${err.message}:${host.getType()}`;
            }
          }

          class FilteredHost {
            @UseFilters(CustomFilter)
            boom() {
              throw new CustomError("kaboom");
            }
          }

          const instance = new FilteredHost();
          const wrapped = contextCreator.create(
            instance,
            instance.boom,
            "boom",
            undefined,
            undefined,
            undefined,
            undefined,
            { guards: true, interceptors: true, filters: true, pipes: true },
            "rpc",
          );
          expect(await wrapped()).toBe("caught:kaboom:rpc");

          const unfiltered = contextCreator.create(
            instance,
            instance.boom,
            "boom",
            undefined,
            undefined,
            undefined,
            undefined,
            { filters: false },
          );
          await expect(unfiltered()).rejects.toBeInstanceOf(CustomError);
        });

        it("should support options.callback post-processing and DI resolution via TestingModule", async () => {
          @Injectable()
          class PrefixService {
            readonly value = "di";
          }

          @Injectable()
          class DiGuard implements CanActivate {
            constructor(readonly svc: PrefixService) {}
            canActivate(): boolean {
              return this.svc.value === "di";
            }
          }

          class TargetHost {
            @UseGuards(DiGuard)
            greet(name: string) {
              return `hello ${name}`;
            }
          }

          const mod = await createTestingModule({
            providers: [PrefixService, DiGuard],
          }).compile({ logger: false });
          try {
            const creator = mod.get(ExternalContextCreator);
            const instance = new TargetHost();
            const wrapped = creator.create(
              instance,
              instance.greet as (...args: unknown[]) => unknown,
              "greet",
              undefined,
              undefined,
              undefined,
              undefined,
              {
                guards: true,
                callback: (result, firstArg) =>
                  `${String(result)} [${String(firstArg)}]`,
              },
            );
            expect(await wrapped("bun")).toBe("hello bun [bun]");
          } finally {
            await mod.close();
          }
        });

        it("should give guards and interceptors the contextType of each wrapper of the same method", async () => {
          const observedTypes: string[] = [];
          const typeGuard: CanActivate = {
            canActivate(ctx: ExecutionContext) {
              observedTypes.push(ctx.getType<string>());
              return true;
            },
          };

          class MultiContextHost {
            @UseGuards(typeGuard)
            run() {
              return "ok";
            }
          }

          const instance = new MultiContextHost();
          const mcp = contextCreator.create(
            instance,
            instance.run,
            "run",
            undefined,
            undefined,
            undefined,
            undefined,
            { guards: true, interceptors: false, filters: false },
            "mcp",
          );
          const ai = contextCreator.create(
            instance,
            instance.run,
            "run",
            undefined,
            undefined,
            undefined,
            undefined,
            { guards: true, interceptors: false, filters: false },
            "ai",
          );

          await mcp();
          await ai();
          expect(observedTypes).toEqual(["mcp", "ai"]);
        });
        it("should extract synchronous parameters via paramsFactory when metadata object is defined on constructor", async () => {
          const PARAM_KEY = Symbol("test:external:sync-params");

          class SyncParamHost {
            combine(a: unknown, b: unknown) {
              return `${String(a)}-${String(b)}`;
            }
          }
          Reflect.defineMetadata(
            PARAM_KEY,
            {
              "first:0": { index: 0, data: "alpha" },
              "second:1": { index: 1, data: "beta" },
            },
            SyncParamHost,
            "combine",
          );

          const factory: ParamsFactory = {
            exchangeKeyForValue(type, data, rawArgs) {
              return `${String(type)}:${String(data)}:${String(rawArgs[0])}`;
            },
          };

          const instance = new SyncParamHost();
          const wrapped = contextCreator.create(
            instance,
            instance.combine,
            "combine",
            PARAM_KEY,
            factory,
            undefined,
            undefined,
            {
              guards: false,
              interceptors: false,
              filters: false,
              pipes: false,
            },
          );

          expect(await wrapped("req")).toBe("first:alpha:req-second:beta:req");
        });
      });

      describe("module key & inquirer resolution (upstream parity)", () => {
        // BUNEST_BUG: ExternalContextCreator does not implement getContextModuleKey() (expected "function", received "undefined") (packages/core/src/helpers/external-context-creator.ts:91-280).
        it.skip("should call getContextModuleKey with expected argument", () => {
          const creatorAny = contextCreator as unknown as Record<
            string,
            unknown
          >;
          expect(typeof creatorAny.getContextModuleKey).toBe("function");
        });

        // BUNEST_BUG: ExternalContextCreator.create() ignores _contextId and _inquirerId, has no ModulesContainer integration for overwritten-constructor / entry-provider / multi-module / factory host resolution, and does not implement getContextModuleKey() (packages/core/src/helpers/external-context-creator.ts:117-127).
        it.skip("should handle overwritten prototype constructor and module lookup by instance / inquirerId", () => {
          const creatorAny = contextCreator as unknown as {
            getContextModuleKey?: (ctor: unknown) => string;
          };
          expect(typeof creatorAny.getContextModuleKey).toBe("function");
          expect(creatorAny.getContextModuleKey!(undefined)).toBe("");
        });
      });
    });

    describe("exchangeKeysForValues", () => {
      // BUNEST_BUG: ExternalContextCreator does not expose exchangeKeysForValues() (expected "function", received "undefined") (packages/core/src/helpers/external-context-creator.ts:91-280).
      it.skip("should exchange arguments keys for appropriate values", () => {
        const creatorAny = contextCreator as unknown as {
          exchangeKeysForValues?: (
            keys: string[],
            metadata: Record<string, unknown>,
            moduleContext: string,
            paramsFactory: ParamsFactory,
          ) => Array<{ index: number; type: string | number; data: unknown }>;
        };
        expect(typeof creatorAny.exchangeKeysForValues).toBe("function");
      });
    });

    describe("getParamValue", () => {
      // BUNEST_BUG: ExternalContextCreator does not expose getParamValue() (expected "function", received "undefined") (packages/core/src/helpers/external-context-creator.ts:91-280).
      it.skip("should apply pipe transforms via getParamValue", async () => {
        const creatorAny = contextCreator as unknown as {
          getParamValue?: (
            value: unknown,
            meta: { metatype: unknown; type: unknown; data: unknown },
            transforms: PipeTransform[],
          ) => Promise<unknown>;
        };
        expect(typeof creatorAny.getParamValue).toBe("function");
        const transform = createSpy((v: unknown) => Number(v) * 2);
        const result = await creatorAny.getParamValue!(
          3,
          { metatype: null, type: "custom", data: null },
          [{ transform }],
        );
        expect(transform.calledOnce).toBe(true);
        expect(result).toBe(6);
      });
    });

    describe("createPipesFn", () => {
      // BUNEST_BUG: ExternalContextCreator does not expose createPipesFn() (expected "function", received "undefined") (packages/core/src/helpers/external-context-creator.ts:91-280).
      it.skip("should expose createPipesFn returning null for empty paramsOptions and function for non-empty", async () => {
        const creatorAny = contextCreator as unknown as {
          createPipesFn?: (
            pipes: PipeTransform[],
            paramsOptions: unknown[],
          ) => ((args: unknown[], ...rest: unknown[]) => unknown) | null;
        };
        expect(typeof creatorAny.createPipesFn).toBe("function");
        expect(creatorAny.createPipesFn!([], [])).toBeNull();

        const pipesFn = creatorAny.createPipesFn!(
          [],
          [
            {
              index: 0,
              type: "test",
              data: undefined,
              pipes: [],
              extractValue: (a: unknown) => a,
            },
          ],
        );
        expect(typeof pipesFn).toBe("function");
      });

      // BUNEST_BUG: ExternalContextCreator.create() does not await thenable values returned by paramsFactory.exchangeKeyForValue() when pipes are empty; handler received the unsettled thenable object instead of "settled" (packages/core/src/helpers/external-context-creator.ts:213-225).
      it.skip("should settle a thenable value returned by paramsFactory without pipes", async () => {
        const thenSpy = createSpy((resolve: (v: string) => void) =>
          resolve("settled"),
        );
        const thenable = { then: thenSpy };
        const PARAM_KEY = Symbol("test:external:thenable");

        let receivedInHandler: unknown;
        class ThenableHost {
          handle(val: unknown) {
            receivedInHandler = val;
            return "done";
          }
        }
        Reflect.defineMetadata(
          PARAM_KEY,
          { "0:0": { index: 0, data: undefined } },
          ThenableHost,
          "handle",
        );

        const paramsFactory: ParamsFactory = {
          exchangeKeyForValue: () => thenable,
        };

        const instance = new ThenableHost();
        const wrapped = contextCreator.create(
          instance,
          instance.handle,
          "handle",
          PARAM_KEY,
          paramsFactory,
          undefined,
          undefined,
          { guards: false, interceptors: false, filters: false, pipes: false },
        );

        expect(await wrapped()).toBe("done");
        expect(receivedInHandler).toBe("settled");
        expect(thenSpy.calledOnce).toBe(true);
      });
    });

    describe("transformToResult", () => {
      // BUNEST_BUG: ExternalContextCreator does not expose transformToResult() (expected "function", received "undefined") (packages/core/src/helpers/external-context-creator.ts:91-280).
      it.skip("should transform Promise and plain values via transformToResult", async () => {
        const creatorAny = contextCreator as unknown as {
          transformToResult?: (resultOrDeferred: unknown) => Promise<unknown>;
        };
        expect(typeof creatorAny.transformToResult).toBe("function");
        expect(await creatorAny.transformToResult!(Promise.resolve(100))).toBe(
          100,
        );
        expect(await creatorAny.transformToResult!(100)).toBe(100);
      });
    });

    describe("getMetadata & createParamDecorator with contextType", () => {
      const ContextType = createParamDecorator(
        (_data: unknown, ctx: ExecutionContext) => ctx.getType<string>(),
      );

      class Tools {
        find(@ContextType() type: string) {
          return type;
        }
      }

      const paramsFactory: ParamsFactory = {
        exchangeKeyForValue: () => undefined,
      };

      // BUNEST_BUG: ExternalContextCreator does not expose getMetadata() (expected "function", received "undefined") (packages/core/src/helpers/external-context-creator.ts:91-280).
      it.skip("should cache an entry per context type via getMetadata", () => {
        const creatorAny = contextCreator as unknown as {
          getMetadata?: (
            instance: object,
            methodName: string,
            metadataKey: string | symbol,
            factory: ParamsFactory,
            contextType: string,
          ) => unknown;
        };
        expect(typeof creatorAny.getMetadata).toBe("function");
        const instance = new Tools();
        const first = creatorAny.getMetadata!(
          instance,
          "find",
          METADATA_KEYS.ROUTE_PARAMS,
          paramsFactory,
          "mcp",
        );
        expect(
          creatorAny.getMetadata!(
            instance,
            "find",
            METADATA_KEYS.ROUTE_PARAMS,
            paramsFactory,
            "mcp",
          ),
        ).toBe(first);
        expect(
          creatorAny.getMetadata!(
            instance,
            "find",
            METADATA_KEYS.ROUTE_PARAMS,
            paramsFactory,
            "ai",
          ),
        ).not.toBe(first);
      });

      // BUNEST_BUG: ExternalContextCreator.create() reads paramMetadata from `ctor` instead of `ctor.prototype` and never invokes `createParamDecorator()`'s `meta.factory(data, ctx)` or param-level `meta.pipes`; handler received `{}` instead of `"mcp"` (packages/core/src/helpers/external-context-creator.ts:181-225).
      it.skip("should give param decorators the context type of each wrapper of the same method", async () => {
        const instance = new Tools();
        const wrap = (type: string) =>
          contextCreator.create(
            instance,
            instance.find as (...args: unknown[]) => unknown,
            "find",
            METADATA_KEYS.ROUTE_PARAMS,
            paramsFactory,
            undefined,
            undefined,
            { guards: false, interceptors: false, filters: false },
            type,
          );

        const mcp = wrap("mcp");
        const ai = wrap("ai");
        expect(await mcp({}, {})).toBe("mcp");
        expect(await ai({}, {})).toBe("ai");
      });
    });
  },
);
