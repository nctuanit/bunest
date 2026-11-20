import "reflect-metadata";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import {
  Logger,
  Reflector,
  type ExecutionContext,
} from "../../../../../packages/common/src";
import {
  THROTTLER_OPTIONS,
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerStorage,
  ThrottlerStorageService,
  type ThrottlerModuleOptions,
  type ThrottlerStorageRecord,
} from "../../../../../packages/security/src";
import {
  Test,
  type TestingModule,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

interface MockEntry {
  totalHits: Record<string, number>;
  expiresAt: number;
  blockExpiresAt: number;
  isBlocked: boolean;
}

class ThrottlerStorageServiceMock implements ThrottlerStorage {
  private readonly _storage = new Map<string, MockEntry>();

  private getExpirationTime(key: string): number {
    return Math.max(
      1,
      (this._storage.get(key)?.expiresAt ?? Date.now()) - Date.now(),
    );
  }

  private getBlockExpirationTime(key: string): number {
    return Math.max(
      0,
      (this._storage.get(key)?.blockExpiresAt ?? 0) - Date.now(),
    );
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration = 0,
    throttlerName = "default",
  ): Promise<ThrottlerStorageRecord> {
    let entry = this._storage.get(key);
    if (!entry) {
      entry = {
        totalHits: { [throttlerName]: 0 },
        expiresAt: Date.now() + ttl,
        blockExpiresAt: 0,
        isBlocked: false,
      };
      this._storage.set(key, entry);
    }

    if (entry.totalHits[throttlerName] === undefined) {
      entry.totalHits[throttlerName] = 0;
    }

    let timeToExpire = entry.expiresAt - Date.now();
    if (timeToExpire <= 0) {
      entry.expiresAt = Date.now() + ttl;
      timeToExpire = this.getExpirationTime(key);
    }

    if (!entry.isBlocked) {
      entry.totalHits[throttlerName] = (entry.totalHits[throttlerName] ?? 0) + 1;
    }

    if ((entry.totalHits[throttlerName] ?? 0) > limit && !entry.isBlocked) {
      entry.isBlocked = true;
      entry.blockExpiresAt = Date.now() + blockDuration;
    }

    const timeToBlockExpire = this.getBlockExpirationTime(key);
    if (timeToBlockExpire <= 0 && entry.isBlocked) {
      entry.totalHits[throttlerName] = (entry.totalHits[throttlerName] ?? 0) + 1;
    }

    return {
      totalHits: entry.totalHits[throttlerName] ?? 0,
      timeToExpire,
      isBlocked: entry.isBlocked,
      timeToBlockExpire,
    };
  }
}

function contextMockFactory(
  type: "http" | "ws" | "graphql",
  handler: (...args: unknown[]) => unknown,
  mockFunc: Record<string, unknown>,
): ExecutionContext {
  const executionPartial: Partial<ExecutionContext> = {
    getClass: () => ThrottlerStorageServiceMock as any,
    getHandler: () => handler as any,
    switchToRpc: () =>
      ({
        getContext: () => ({}),
        getData: () => ({}),
      }) as any,
    getArgs: () => [] as any,
    getArgByIndex: () => ({}) as any,
    getType: () => type as any,
  };
  switch (type) {
    case "ws":
      executionPartial.switchToHttp = () => ({}) as any;
      executionPartial.switchToWs = () => mockFunc as any;
      break;
    case "http":
      executionPartial.switchToWs = () => ({}) as any;
      executionPartial.switchToHttp = () => mockFunc as any;
      break;
    case "graphql":
      executionPartial.switchToWs = () => ({}) as any;
      executionPartial.switchToHttp = () =>
        ({
          getNext: () => ({}),
        }) as any;
      executionPartial.getArgByIndex = () => mockFunc as any;
      break;
  }
  return executionPartial as ExecutionContext;
}

describeConformance(
  "ThrottlerGuard",
  {
    upstreamPath: "throttler/src/throttler.guard.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010"],
    notes:
      "Upstream commit 849929b4df (@nestjs/throttler@6.8.0). Adapted for Bunest's unified THROTTLE_METADATA reflector shape and Web-standard string header coercion on res.header().",
  },
  () => {
    let modRef: TestingModule;
    let guard: ThrottlerGuard;
    let reflector: Reflector;
    let service: ThrottlerStorageServiceMock;
    let handler: () => string;

    beforeEach(async () => {
      modRef = await Test.createTestingModule({
        providers: [
          ThrottlerGuard,
          {
            provide: THROTTLER_OPTIONS,
            useValue: [
              {
                limit: 5,
                ttl: 60,
                ignoreUserAgents: [/userAgentIgnore/],
              },
            ],
          },
          {
            provide: ThrottlerStorage,
            useClass: ThrottlerStorageServiceMock,
          },
          {
            provide: Reflector,
            useValue: {
              getAllAndOverride: mock(() => undefined),
            },
          },
        ],
      }).compile();
      guard = modRef.get(ThrottlerGuard);
      await guard.onModuleInit();
      reflector = modRef.get(Reflector);
      service = modRef.get<ThrottlerStorageServiceMock>(ThrottlerStorage);
    });

    afterEach(async () => {
      await modRef.close();
    });

    it("should have all of the providers defined", () => {
      expect(guard).toBeDefined();
      expect(reflector).toBeDefined();
      expect(service).toBeDefined();
    });

    describe("HTTP Context", () => {
      let reqMock: Record<string, unknown>;
      let resMock: { header: ReturnType<typeof mock> };
      let headerSettingMock: ReturnType<typeof mock>;

      beforeEach(() => {
        headerSettingMock = mock(() => undefined);
        resMock = {
          header: headerSettingMock,
        };
        reqMock = {
          headers: {},
        };
      });

      afterEach(() => {
        headerSettingMock.mockClear();
      });

      itAdapted(
        "ADR-010",
        "should add headers to the res",
        async () => {
          handler = function addHeaders() {
            return "string";
          };
          const ctxMock = contextMockFactory("http", handler, {
            getResponse: () => resMock,
            getRequest: () => reqMock,
          });
          const canActivate = await guard.canActivate(ctxMock);
          expect(canActivate).toBe(true);
          expect(headerSettingMock).toHaveBeenCalledTimes(3);
          expect(headerSettingMock).toHaveBeenNthCalledWith(
            1,
            "X-RateLimit-Limit",
            "5",
          );
          expect(headerSettingMock).toHaveBeenNthCalledWith(
            2,
            "X-RateLimit-Remaining",
            "4",
          );
          expect(headerSettingMock).toHaveBeenNthCalledWith(
            3,
            "X-RateLimit-Reset",
            expect.stringMatching(/^\d+$/),
          );
        },
        "Bunest ResponseContext.header() receives string header values",
      );

      itAdapted(
        "ADR-010",
        "should return an error after passing the limit",
        async () => {
          handler = function returnError() {
            return "string";
          };
          const ctxMock = contextMockFactory("http", handler, {
            getResponse: () => resMock,
            getRequest: () => reqMock,
          });
          for (let i = 0; i < 5; i++) {
            await guard.canActivate(ctxMock);
          }
          await expect(guard.canActivate(ctxMock)).rejects.toThrow(
            ThrottlerException,
          );
          // 5 allowed requests x 3 headers + 1 blocked request x 4 headers (Limit, Remaining, Reset, Retry-After)
          expect(headerSettingMock).toHaveBeenCalledTimes(19);
          expect(headerSettingMock).toHaveBeenLastCalledWith(
            "Retry-After",
            expect.stringMatching(/^\d+$/),
          );
        },
        "Bunest emits full X-RateLimit-* + Retry-After headers on 429 rejection",
      );

      it("should coerce numeric strings, e.g. read from the environment", async () => {
        handler = function numericStrings() {
          return "string";
        };
        reflector.getAllAndOverride = mock()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce({
            default: { limit: "2", ttl: "60000", blockDuration: "1000" },
          }) as any;
        const incrementSpy = spyOn(service, "increment");
        const ctxMock = contextMockFactory("http", handler, {
          getResponse: () => resMock,
          getRequest: () => reqMock,
        });
        try {
          await expect(guard.canActivate(ctxMock)).resolves.toBe(true);
          expect(incrementSpy).toHaveBeenCalledWith(
            expect.any(String),
            60000,
            2,
            1000,
            "default",
          );
          expect(headerSettingMock).toHaveBeenNthCalledWith(
            1,
            "X-RateLimit-Limit",
            "2",
          );
        } finally {
          incrementSpy.mockRestore();
        }
      });

      it("should reject a non-numeric option with a descriptive error", async () => {
        handler = function invalidOption() {
          return "string";
        };
        reflector.getAllAndOverride = mock()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce({
            default: { ttl: "one minute" },
          }) as any;
        const ctxMock = contextMockFactory("http", handler, {
          getResponse: () => resMock,
          getRequest: () => reqMock,
        });
        await expect(guard.canActivate(ctxMock)).rejects.toThrow(
          'Invalid "ttl" for the "default" throttler: expected a number, got "one minute".',
        );
      });

      it("should pull values from the reflector instead of options", async () => {
        handler = function useReflector() {
          return "string";
        };
        reflector.getAllAndOverride = mock()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce({ default: { limit: 2 } }) as any;
        const ctxMock = contextMockFactory("http", handler, {
          getResponse: () => resMock,
          getRequest: () => reqMock,
        });
        const canActivate = await guard.canActivate(ctxMock);
        expect(canActivate).toBe(true);
        expect(headerSettingMock).toHaveBeenCalledTimes(3);
        expect(headerSettingMock).toHaveBeenNthCalledWith(
          1,
          "X-RateLimit-Limit",
          "2",
        );
        expect(headerSettingMock).toHaveBeenNthCalledWith(
          2,
          "X-RateLimit-Remaining",
          "1",
        );
        expect(headerSettingMock).toHaveBeenNthCalledWith(
          3,
          "X-RateLimit-Reset",
          expect.stringMatching(/^\d+$/),
        );
      });

      it("should respect an explicit route-level limit of 0 instead of falling back to the default", async () => {
        handler = function zeroLimit() {
          return "string";
        };
        reflector.getAllAndOverride = mock()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce({ default: { limit: 0 } }) as any;
        const ctxMock = contextMockFactory("http", handler, {
          getResponse: () => resMock,
          getRequest: () => reqMock,
        });
        await expect(guard.canActivate(ctxMock)).rejects.toThrow(
          ThrottlerException,
        );
        expect(headerSettingMock).toHaveBeenLastCalledWith(
          "Retry-After",
          expect.stringMatching(/^\d+$/),
        );
      });

      it("should pass an explicit route-level blockDuration of 0 to the storage", async () => {
        handler = function zeroBlockDuration() {
          return "string";
        };
        reflector.getAllAndOverride = mock()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce({ default: { blockDuration: 0 } }) as any;
        const incrementSpy = spyOn(service, "increment");
        const ctxMock = contextMockFactory("http", handler, {
          getResponse: () => resMock,
          getRequest: () => reqMock,
        });
        try {
          await guard.canActivate(ctxMock);
          expect(incrementSpy).toHaveBeenCalledWith(
            expect.any(String),
            60,
            5,
            0,
            "default",
          );
        } finally {
          incrementSpy.mockRestore();
        }
      });

      it("should skip due to the user-agent header", async () => {
        handler = function userAgentSkip() {
          return "string";
        };
        reqMock.headers = {
          "user-agent": "userAgentIgnore",
        };
        const ctxMock = contextMockFactory("http", handler, {
          getResponse: () => resMock,
          getRequest: () => reqMock,
        });
        const canActivate = await guard.canActivate(ctxMock);
        expect(canActivate).toBe(true);
        expect(headerSettingMock).toHaveBeenCalledTimes(0);
      });

      it("should accept callback options for ttl and limit", async () => {
        const localMod = await Test.createTestingModule({
          providers: [
            ThrottlerGuard,
            {
              provide: THROTTLER_OPTIONS,
              useValue: [
                {
                  limit: () => 5,
                  ttl: () => 60,
                  ignoreUserAgents: [/userAgentIgnore/],
                },
              ],
            },
            {
              provide: ThrottlerStorage,
              useClass: ThrottlerStorageServiceMock,
            },
            {
              provide: Reflector,
              useValue: {
                getAllAndOverride: mock(() => undefined),
              },
            },
          ],
        }).compile();
        try {
          const localGuard = localMod.get(ThrottlerGuard);
          await localGuard.onModuleInit();
          handler = function addHeaders() {
            return "string";
          };
          const ctxMock = contextMockFactory("http", handler, {
            getResponse: () => resMock,
            getRequest: () => reqMock,
          });
          const canActivate = await localGuard.canActivate(ctxMock);
          expect(canActivate).toBe(true);
          expect(headerSettingMock).toHaveBeenCalledTimes(3);
          expect(headerSettingMock).toHaveBeenNthCalledWith(
            1,
            "X-RateLimit-Limit",
            "5",
          );
          expect(headerSettingMock).toHaveBeenNthCalledWith(
            2,
            "X-RateLimit-Remaining",
            "4",
          );
          expect(headerSettingMock).toHaveBeenNthCalledWith(
            3,
            "X-RateLimit-Reset",
            expect.stringMatching(/^\d+$/),
          );
        } finally {
          await localMod.close();
        }
      });

      it("should fall back to setHeader when the response has no header method", async () => {
        handler = function setHeaderFallback() {
          return "string";
        };
        const setHeaderMock = mock(() => undefined);
        const ctxMock = contextMockFactory("http", handler, {
          getResponse: () => ({ setHeader: setHeaderMock }),
          getRequest: () => reqMock,
        });
        for (let i = 0; i < 5; i++) {
          await guard.canActivate(ctxMock);
        }
        await expect(guard.canActivate(ctxMock)).rejects.toThrow(
          ThrottlerException,
        );
        expect(setHeaderMock).toHaveBeenNthCalledWith(
          1,
          "X-RateLimit-Limit",
          5,
        );
        expect(setHeaderMock).toHaveBeenLastCalledWith(
          "Retry-After",
          expect.any(Number),
        );
      });

      it("should not fail when the response cannot set headers", async () => {
        handler = function noHeaderMethods() {
          return "string";
        };
        const ctxMock = contextMockFactory("http", handler, {
          getResponse: () => ({}),
          getRequest: () => reqMock,
        });
        await expect(guard.canActivate(ctxMock)).resolves.toBe(true);
      });

      it("should not add headers to the response when setHeaders is false", async () => {
        const localMod = await Test.createTestingModule({
          providers: [
            ThrottlerGuard,
            {
              provide: THROTTLER_OPTIONS,
              useValue: [
                {
                  limit: 5,
                  ttl: 60,
                  setHeaders: false,
                },
              ],
            },
            {
              provide: ThrottlerStorage,
              useClass: ThrottlerStorageServiceMock,
            },
            {
              provide: Reflector,
              useValue: {
                getAllAndOverride: mock(() => undefined),
              },
            },
          ],
        }).compile();

        try {
          const localGuard = localMod.get(ThrottlerGuard);
          await localGuard.onModuleInit();

          const localHeaderMock = mock(() => undefined);
          handler = function noHeaders() {
            return "string";
          };

          const ctxMock = contextMockFactory("http", handler, {
            getResponse: () => ({ header: localHeaderMock }),
            getRequest: () => ({ headers: {} }),
          });

          for (let i = 0; i < 5; i++) {
            const canActivate = await localGuard.canActivate(ctxMock);
            expect(canActivate).toBe(true);
          }

          expect(localHeaderMock).not.toHaveBeenCalled();

          await expect(localGuard.canActivate(ctxMock)).rejects.toThrow(
            ThrottlerException,
          );

          expect(localHeaderMock).not.toHaveBeenCalled();
        } finally {
          await localMod.close();
        }
      });

      it("should respect setHeaders option from commonOptions", async () => {
        const localMod = await Test.createTestingModule({
          providers: [
            ThrottlerGuard,
            {
              provide: THROTTLER_OPTIONS,
              useValue: {
                throttlers: [
                  {
                    limit: 5,
                    ttl: 60,
                  },
                ],
                setHeaders: false,
              },
            },
            {
              provide: ThrottlerStorage,
              useClass: ThrottlerStorageServiceMock,
            },
            {
              provide: Reflector,
              useValue: {
                getAllAndOverride: mock(() => undefined),
              },
            },
          ],
        }).compile();

        try {
          const localGuard = localMod.get(ThrottlerGuard);
          await localGuard.onModuleInit();

          handler = function commonOptionsTest() {
            return "string";
          };

          const ctxMock = contextMockFactory("http", handler, {
            getResponse: () => resMock,
            getRequest: () => reqMock,
          });

          const canActivate = await localGuard.canActivate(ctxMock);
          expect(canActivate).toBe(true);
          expect(headerSettingMock).not.toHaveBeenCalled();
        } finally {
          await localMod.close();
        }
      });
    });

    describe("tracker normalization", () => {
      const makeGuard = async (options: ThrottlerModuleOptions) => {
        const localMod = await Test.createTestingModule({
          providers: [
            ThrottlerGuard,
            { provide: THROTTLER_OPTIONS, useValue: options },
            { provide: ThrottlerStorage, useClass: ThrottlerStorageServiceMock },
            {
              provide: Reflector,
              useValue: { getAllAndOverride: mock(() => undefined) },
            },
          ],
        }).compile();
        const localGuard = localMod.get(ThrottlerGuard);
        await localGuard.onModuleInit();
        return {
          getTracker: (req: Record<string, unknown>) =>
            (localGuard as unknown as {
              getTracker: (r: Record<string, unknown>) => Promise<string>;
            }).getTracker(req),
          close: () => localMod.close(),
        };
      };

      it("masks IPv6 to a /64 by default", async () => {
        const { getTracker, close } = await makeGuard({
          throttlers: [{ limit: 5, ttl: 60 }],
        });
        try {
          await expect(
            getTracker({ ip: "2001:db8:0:1:dead:beef:1:2" }),
          ).resolves.toBe("2001:db8:0:1::/64");
        } finally {
          await close();
        }
      });

      it("honours ipv6SubnetPrefix from the module options", async () => {
        const { getTracker, close } = await makeGuard({
          ipv6SubnetPrefix: 48,
          throttlers: [{ limit: 5, ttl: 60 }],
        });
        try {
          await expect(
            getTracker({ ip: "2001:db8:0:1:dead:beef:1:2" }),
          ).resolves.toBe("2001:db8::/48");
        } finally {
          await close();
        }
      });

      it("still masks when ipv6SubnetPrefix is not a finite number", async () => {
        const { getTracker, close } = await makeGuard({
          ipv6SubnetPrefix: Number(undefined),
          throttlers: [{ limit: 5, ttl: 60 }],
        });
        try {
          await expect(
            getTracker({ ip: "2001:db8:0:1:dead:beef:1:2" }),
          ).resolves.toBe("2001:db8:0:1::/64");
        } finally {
          await close();
        }
      });

      it("uses the default when options are given in array form", async () => {
        const { getTracker, close } = await makeGuard([{ limit: 5, ttl: 60 }]);
        try {
          await expect(
            getTracker({ ip: "2001:db8:0:1:dead:beef:1:2" }),
          ).resolves.toBe("2001:db8:0:1::/64");
        } finally {
          await close();
        }
      });
    });

    describe("empty configuration", () => {
      const buildGuard = async (options: ThrottlerModuleOptions) => {
        const localMod = await Test.createTestingModule({
          providers: [
            ThrottlerGuard,
            { provide: THROTTLER_OPTIONS, useValue: options },
            { provide: ThrottlerStorage, useClass: ThrottlerStorageServiceMock },
            {
              provide: Reflector,
              useValue: { getAllAndOverride: mock(() => undefined) },
            },
          ],
        }).compile();
        return {
          guard: localMod.get(ThrottlerGuard),
          close: () => localMod.close(),
        };
      };

      it("warns when no throttler is configured", async () => {
        const warn = spyOn(Logger.prototype, "warn").mockImplementation(
          () => undefined,
        );
        const { guard: localGuard, close } = await buildGuard([]);
        try {
          await localGuard.onModuleInit();
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("No throttlers are configured"),
          );
        } finally {
          warn.mockRestore();
          await close();
        }
      });

      it("does not warn when a throttler is configured", async () => {
        const warn = spyOn(Logger.prototype, "warn").mockImplementation(
          () => undefined,
        );
        const { guard: localGuard, close } = await buildGuard([
          { limit: 5, ttl: 60 },
        ]);
        try {
          await localGuard.onModuleInit();
          expect(warn).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
          await close();
        }
      });
    });

    describe("throttler order", () => {
      it("sorts throttlers with a static ttl by ttl and puts callback ttls last", async () => {
        const storage = new ThrottlerStorageService();
        try {
          const localGuard = new ThrottlerGuard(
            {
              throttlers: [
                { name: "medium", limit: 5, ttl: 10000 },
                { name: "dynamic", limit: 5, ttl: () => 5000 },
                { name: "short", limit: 1, ttl: 1000 },
              ],
            },
            storage,
            new Reflector(),
          );
          await localGuard.onModuleInit();
          const throttlers = (
            localGuard as unknown as {
              throttlers: Array<{ name?: string }>;
            }
          ).throttlers;
          expect(throttlers.map((throttler) => throttler.name)).toEqual([
            "short",
            "medium",
            "dynamic",
          ]);
        } finally {
          storage.onModuleDestroy();
        }
      });
    });

    describe("ignoreUserAgents with a stateful regular expression", () => {
      it.each([[/bot/g], [/bot/y]])(
        "should ignore every request matching %s",
        async (pattern) => {
          const storage = new ThrottlerStorageService();
          try {
            const localGuard = new ThrottlerGuard(
              { throttlers: [{ limit: 1, ttl: 60000 }], ignoreUserAgents: [pattern] },
              storage,
              new Reflector(),
            );
            await localGuard.onModuleInit();
            const context = {
              getClass: () => class Controller {},
              getHandler: () => function handler() {},
              switchToHttp: () => ({
                getRequest: () => ({
                  ip: "127.0.0.1",
                  headers: { "user-agent": "bot" },
                }),
                getResponse: () => ({ header: mock(() => undefined) }),
              }),
            } as unknown as ExecutionContext;

            for (let i = 0; i < 4; i++) {
              await expect(localGuard.canActivate(context)).resolves.toBe(true);
            }
          } finally {
            storage.onModuleDestroy();
          }
        },
      );
    });
  },
);
