import { afterEach, describe, expect, it } from "bun:test";
import { Injectable, Module } from "../../../../packages/core/src/common";
import {
  HttpClient,
  HttpClientModule,
  type HttpClientOptionsFactory,
} from "../../../../packages/core/src/client";
import {
  Test,
  describeConformance,
  itAdapted,
} from "../../_helpers/index";

@Injectable()
class ConfigService {
  readonly baseUrl = "https://from-config-service.example";
}

@Injectable()
class HttpConfigFactory implements HttpClientOptionsFactory {
  createHttpClientOptions() {
    return { baseUrl: "https://from-factory-class.example", timeout: 1234 };
  }
}

@Module({
  providers: [ConfigService, HttpConfigFactory],
  exports: [ConfigService, HttpConfigFactory],
})
class ConfigModule {}

function getClientConfig(client: HttpClient): {
  baseUrl?: string;
  timeout?: number;
} {
  return (client as unknown as { config: { baseUrl?: string; timeout?: number } })
    .config;
}

describeConformance(
  "HttpClientModule (axios parity)",
  {
    upstreamPath: "axios/tests/http.module.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-017"],
    notes:
      "Adapts upstream @nestjs/axios HttpModule tests to zero-dep Bunest @bunest/core/client (HttpClientModule / HttpClient on native fetch).",
  },
  () => {
    const modules: { close: () => Promise<unknown> }[] = [];

    const compile = async (
      metadata: Parameters<typeof Test.createTestingModule>[0],
    ) => {
      const moduleRef = await Test.createTestingModule(metadata).compile({
        logger: false,
      });
      modules.push(moduleRef);
      return moduleRef;
    };

    afterEach(async () => {
      await Promise.all(modules.splice(0).map((m) => m.close()));
    });

    describe("register", () => {
      itAdapted(
        ["ADR-001", "ADR-017"],
        "exposes an HttpClient carrying the configured options",
        async () => {
          const moduleRef = await compile({
            imports: [
              HttpClientModule.register({
                baseUrl: "https://example.com",
                timeout: 4200,
              }),
            ],
          });

          const client = moduleRef.get(HttpClient);
          expect(client).toBeInstanceOf(HttpClient);
          expect(getClientConfig(client).baseUrl).toBe("https://example.com");
          expect(getClientConfig(client).timeout).toBe(4200);
        },
        "Bunest @bunest/core/client exposes HttpClient instead of axiosRef",
      );

      it("creates a dedicated HttpClient instance per module rather than sharing a global default", async () => {
        const first = await compile({
          imports: [
            HttpClientModule.register({ baseUrl: "https://one.example" }),
          ],
        });
        const second = await compile({
          imports: [
            HttpClientModule.register({ baseUrl: "https://two.example" }),
          ],
        });

        const a = first.get(HttpClient);
        const b = second.get(HttpClient);

        expect(a).not.toBe(b);
        expect(getClientConfig(a).baseUrl).toBe("https://one.example");
        expect(getClientConfig(b).baseUrl).toBe("https://two.example");
      });

      it("honours the isGlobal flag", () => {
        expect(HttpClientModule.register({ isGlobal: true }).global).toBe(true);
        expect(HttpClientModule.register({}).global).toBeFalsy();
      });
    });

    describe("registerAsync", () => {
      it("supports useFactory with injected dependencies", async () => {
        const moduleRef = await compile({
          imports: [
            HttpClientModule.registerAsync({
              imports: [ConfigModule],
              inject: [ConfigService],
              useFactory: (config: ConfigService) => ({
                baseUrl: config.baseUrl,
              }),
            }),
          ],
        });

        expect(getClientConfig(moduleRef.get(HttpClient)).baseUrl).toBe(
          "https://from-config-service.example",
        );
      });

      it("supports an async useFactory", async () => {
        const moduleRef = await compile({
          imports: [
            HttpClientModule.registerAsync({
              useFactory: async () => ({ baseUrl: "https://async.example" }),
            }),
          ],
        });

        expect(getClientConfig(moduleRef.get(HttpClient)).baseUrl).toBe(
          "https://async.example",
        );
      });

      it("supports useClass", async () => {
        const moduleRef = await compile({
          imports: [
            HttpClientModule.registerAsync({ useClass: HttpConfigFactory }),
          ],
        });

        const cfg = getClientConfig(moduleRef.get(HttpClient));
        expect(cfg.baseUrl).toBe("https://from-factory-class.example");
        expect(cfg.timeout).toBe(1234);
      });

      it("supports useExisting", async () => {
        const moduleRef = await compile({
          imports: [
            HttpClientModule.registerAsync({
              imports: [ConfigModule],
              useExisting: HttpConfigFactory,
            }),
          ],
        });

        expect(getClientConfig(moduleRef.get(HttpClient)).baseUrl).toBe(
          "https://from-factory-class.example",
        );
      });

      it("registers extraProviders", async () => {
        const moduleRef = await compile({
          imports: [
            HttpClientModule.registerAsync({
              useFactory: () => ({}),
              extraProviders: [{ provide: "EXTRA", useValue: "extra-value" }],
            }),
          ],
        });

        expect(moduleRef.get("EXTRA")).toBe("extra-value");
      });

      itAdapted(
        ["ADR-001"],
        "resolves async options into the HttpClient instance",
        async () => {
          const moduleRef = await compile({
            imports: [
              HttpClientModule.registerAsync({
                useFactory: () => ({ timeout: 999 }),
              }),
            ],
          });

          const client = moduleRef.get(HttpClient);
          expect(client).toBeInstanceOf(HttpClient);
          expect(getClientConfig(client).timeout).toBe(999);
        },
        "Bunest resolves async options into native HttpClient",
      );

      it("honours the isGlobal flag", () => {
        expect(
          HttpClientModule.registerAsync({
            isGlobal: true,
            useFactory: () => ({}),
          }).global,
        ).toBe(true);
      });
    });
  },
);
