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
  Injectable,
  Logger,
  type LoggerService,
} from "../../../../../packages/core/src/common";
import {
  HealthIndicatorService,
  TERMINUS_LOGGER,
  TerminusModule,
} from "../../../../../packages/observability/src";
import {
  Test,
  type TestingModule,
  describeConformance,
} from "../../../_helpers/index";

@Injectable()
class CustomLogger implements LoggerService {
  log = mock(() => {});
  error = mock(() => {});
  warn = mock(() => {});
}

describeConformance(
  "HealthIndicatorService",
  {
    upstreamPath:
      "terminus/lib/health-indicator/service/health-indicator.service.spec.ts",
    category: "DIRECT_PORT",
    notes:
      "Direct port of upstream @nestjs/terminus HealthIndicatorService warning logger routing tests.",
  },
  () => {
    let keyCounter = 0;
    let currentKey = "";
    let nestWarn: ReturnType<typeof spyOn>;
    const modules: TestingModule[] = [];

    // Warnings are logged once per indicator key for the whole process, so each
    // test uses its own unique indicator key.
    const key = () => currentKey;

    // The returned value of `attempt()` is deprecated and logs a warning
    const warnOnce = (service: HealthIndicatorService) =>
      service.check(key()).attempt(() => ({ ok: 1 }));

    const compile = async (
      metadata: Parameters<typeof Test.createTestingModule>[0],
    ) => {
      const mod = await Test.createTestingModule(metadata).compile({
        logger: false,
      });
      modules.push(mod);
      return mod;
    };

    beforeEach(() => {
      keyCounter += 1;
      currentKey = `health-indicator-service-test-${keyCounter}`;
      nestWarn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    });

    afterEach(async () => {
      nestWarn.mockRestore();
      await Promise.all(modules.splice(0).map((m) => m.close()));
    });

    it("should log the warnings with the Nest logger by default", async () => {
      const module = await compile({
        imports: [TerminusModule.forRoot()],
      });

      await warnOnce(module.get(HealthIndicatorService));

      expect(nestWarn).toHaveBeenCalledWith(
        expect.stringContaining(`"${key()}"`),
        "HealthIndicatorService",
      );
    });

    it("should log no warning with logger: false", async () => {
      const module = await compile({
        imports: [TerminusModule.forRoot({ logger: false })],
      });

      await warnOnce(module.get(HealthIndicatorService));

      expect(nestWarn).not.toHaveBeenCalled();
    });

    it("should log the warnings with a custom logger", async () => {
      const module = await compile({
        imports: [TerminusModule.forRoot({ logger: CustomLogger })],
      });

      await warnOnce(module.get(HealthIndicatorService));

      expect(nestWarn).not.toHaveBeenCalled();
      expect(
        module.get<CustomLogger>(TERMINUS_LOGGER).warn,
      ).toHaveBeenCalledWith(
        expect.stringContaining(`"${key()}"`),
        "HealthIndicatorService",
      );
    });

    it("should log the warnings with a custom logger from forRootAsync", async () => {
      const logger = new CustomLogger();
      const module = await compile({
        imports: [
          TerminusModule.forRootAsync({ useFactory: () => ({ logger }) }),
        ],
      });

      await warnOnce(module.get(HealthIndicatorService));

      expect(nestWarn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`"${key()}"`),
        "HealthIndicatorService",
      );
    });

    it("should log no warning with logger: false from forRootAsync", async () => {
      const module = await compile({
        imports: [
          TerminusModule.forRootAsync({
            useFactory: () => ({ logger: false }),
          }),
        ],
      });

      await warnOnce(module.get(HealthIndicatorService));

      expect(nestWarn).not.toHaveBeenCalled();
    });

    describe("logger routing with reserved-key warning", () => {
      const triggerReservedKeyWarn = (service: HealthIndicatorService) =>
        service
          .check(`${key()}:reserved`)
          .attempt(() => {})
          .withData({ status: "x" });

      it("routes warnings to the default Logger", async () => {
        const module = await compile({
          imports: [TerminusModule.forRoot()],
        });

        await triggerReservedKeyWarn(module.get(HealthIndicatorService));

        expect(nestWarn).toHaveBeenCalledWith(
          expect.stringContaining(`"${key()}:reserved"`),
          "HealthIndicatorService",
        );
      });

      it("suppresses warnings when logger: false in forRoot", async () => {
        const module = await compile({
          imports: [TerminusModule.forRoot({ logger: false })],
        });

        await triggerReservedKeyWarn(module.get(HealthIndicatorService));

        expect(nestWarn).not.toHaveBeenCalled();
      });

      it("routes warnings to a custom logger class in forRoot", async () => {
        const module = await compile({
          imports: [TerminusModule.forRoot({ logger: CustomLogger })],
        });

        await triggerReservedKeyWarn(module.get(HealthIndicatorService));

        expect(nestWarn).not.toHaveBeenCalled();
        expect(
          module.get<CustomLogger>(TERMINUS_LOGGER).warn,
        ).toHaveBeenCalledWith(
          expect.stringContaining(`"${key()}:reserved"`),
          "HealthIndicatorService",
        );
      });

      it("routes warnings to a custom logger instance in forRootAsync", async () => {
        const logger = new CustomLogger();
        const module = await compile({
          imports: [
            TerminusModule.forRootAsync({ useFactory: () => ({ logger }) }),
          ],
        });

        await triggerReservedKeyWarn(module.get(HealthIndicatorService));

        expect(nestWarn).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining(`"${key()}:reserved"`),
          "HealthIndicatorService",
        );
      });

      it("suppresses warnings when logger: false in forRootAsync", async () => {
        const module = await compile({
          imports: [
            TerminusModule.forRootAsync({
              useFactory: () => ({ logger: false }),
            }),
          ],
        });

        await triggerReservedKeyWarn(module.get(HealthIndicatorService));

        expect(nestWarn).not.toHaveBeenCalled();
      });
    });
  },
);
