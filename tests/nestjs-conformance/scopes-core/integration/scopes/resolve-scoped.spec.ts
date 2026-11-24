import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Scope,
  type FactoryProvider,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance } from "../../../_helpers";

const LOGGER_PROVIDER = "LOGGER_PROVIDER";

const loggerProvider: FactoryProvider = {
  provide: LOGGER_PROVIDER,
  useFactory: () => ({ logger: true }),
};

@Injectable({ scope: Scope.TRANSIENT })
class LoggerService {
  constructor(@Inject(LOGGER_PROVIDER) public logger: { logger: boolean }) {}
}

@Injectable({ scope: Scope.REQUEST })
class RequestLoggerService {
  constructor(public loggerService: LoggerService) {}
}

describeConformance(
  "Resolve method",
  {
    upstreamPath: "integration/scopes/e2e/resolve-scoped.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-012"],
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        providers: [LoggerService, loggerProvider, RequestLoggerService],
      }).compile();

      app = module.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should resolve transient logger", async () => {
      const transientLogger = await app.resolve(LoggerService);
      expect(transientLogger.logger).toEqual({
        logger: true,
      });
    });

    it("should resolve request-scoped logger", async () => {
      const requestScoped = await app.resolve(RequestLoggerService);

      expect(requestScoped.loggerService).toBeInstanceOf(LoggerService);
      expect(requestScoped.loggerService.logger).toEqual({
        logger: true,
      });
    });
  },
);
