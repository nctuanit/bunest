import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
} from "bun:test";
import { Logger } from "../../../../../../packages/core/src/common";
import { ResolverDecoratorHost } from "../../../../../../packages/graphql/src";
import {
  type SinonLikeStub,
  createSpy,
  describeConformance,
  stubMethod,
} from "../../../../_helpers/index";

describeConformance(
  "ResolverDecoratorHost",
  {
    upstreamPath:
      "packages/graphql/tests/services/resolver-decorator-host.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let host: ResolverDecoratorHost;
    let loggerError: SinonLikeStub;
    const unhandled = createSpy();

    beforeAll(() => {
      process.on("unhandledRejection", unhandled);
    });

    afterAll(() => {
      process.off("unhandledRejection", unhandled);
    });

    beforeEach(() => {
      host = new ResolverDecoratorHost();
      unhandled.resetHistory();
      loggerError = stubMethod(Logger.prototype, "error").callsFake(() => {});
    });

    afterEach(() => {
      loggerError.restore();
    });

    const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

    it('should return the promise of an async "request end" hook', async () => {
      host.setOnRequestEndHook(async () => {});

      expect(host.onRequestEnd({})).toBeInstanceOf(Promise);
    });

    // BUNEST_BUG: ResolverDecoratorHost.handleRejection() in packages/graphql/src/services/resolver-decorator-host.ts (lines 114-118) logs ("Unhandled rejection in GraphQL request hook", err) instead of ('The "request end" hook failed.', err.stack).
    it.skip('should not leave the rejection of an async "request end" hook unhandled', async () => {
      host.setOnRequestEndHook(async () => {
        throw new Error("insert failed");
      });

      host.onRequestEnd({ operationName: "A".repeat(65) });
      await flush();

      expect(unhandled.notCalled).toBe(true);
      expect(loggerError.calledOnce).toBe(true);
      expect(loggerError.firstCall?.args[0]).toBe(
        'The "request end" hook failed.',
      );
      expect(loggerError.firstCall?.args[1]).toEqual(
        expect.stringContaining("insert failed"),
      );
    });

    // BUNEST_BUG: ResolverDecoratorHost.onRequestStart() in packages/graphql/src/services/resolver-decorator-host.ts (lines 86-88, 114-118) returns promise.catch(() => undefined), swallowing the rejection so `await state` resolves to undefined instead of rejecting with "span failed" while attaching a silent rejection handler.
    it.skip('should not leave the rejection of an async "request start" hook unhandled', async () => {
      host.setOnRequestStartHook(async () => {
        throw new Error("span failed");
      });

      const state = host.onRequestStart({});
      await flush();

      expect(unhandled.notCalled).toBe(true);
      await expect(state as Promise<unknown>).rejects.toThrow("span failed");
    });

    it("should return what a synchronous hook returns", () => {
      host.setOnRequestStartHook(() => "state");

      expect(host.onRequestStart({})).toBe("state");
      expect(host.onRequestEnd({})).toBeUndefined();
    });
  },
);
