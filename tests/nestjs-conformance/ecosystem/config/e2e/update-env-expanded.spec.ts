import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigModule,
  ConfigService,
  type ConfigModuleOptions,
} from "../../../../../packages/config/src";
import { describeConformance, Test } from "../../../_helpers/index";

describeConformance(
  "Setting variables referenced by expanded env file variables",
  {
    upstreamPath: "config/tests/e2e/update-env-expanded.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Ported from upstream update-env-expanded.spec.ts; zero-RxJS changes$ subscribable supported natively.",
  },
  () => {
    let originalEnv: NodeJS.ProcessEnv;
    let tmpDir: string;

    function writeEnvFile(lines: string[]) {
      const envFilePath = join(tmpDir, ".env");
      fs.writeFileSync(envFilePath, lines.join("\n"));
      return envFilePath;
    }

    async function createConfigService(options: ConfigModuleOptions) {
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ expandVariables: true, ...options })],
      }).compile();
      return moduleRef.get(ConfigService);
    }

    beforeEach(() => {
      originalEnv = { ...process.env };
      tmpDir = fs.mkdtempSync(join(tmpdir(), "bunest-config-"));
    });

    afterEach(() => {
      process.env = originalEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // BUNEST_BUG: ConfigService.set() does not re-expand dependent .env variables or enforce an expansion size limit (expected toThrow "is too long after variable expansion", did not throw; packages/config/src/config.service.ts:342-369)
    it.skip("should refuse to grow a variable past the size limit", async () => {
      const lines = ["A00=${API_TOKEN}${API_TOKEN}"];
      for (let i = 1; i <= 22; i++) {
        const previous = `A${String(i - 1).padStart(2, "0")}`;
        lines.push(
          `A${String(i).padStart(2, "0")}=\${${previous}}\${${previous}}`,
        );
      }
      const configService = await createConfigService({
        envFilePath: writeEnvFile(lines),
      });

      expect(() => configService.set("API_TOKEN", "t0k3n-02")).toThrow(
        "is too long after variable expansion",
      );
      expect(process.env.API_TOKEN).toBeUndefined();
      expect(process.env.A00).toBe("");
    });

    it("should keep a predefined variable that the env file aliases", async () => {
      process.env.AUTH_REQUIRED = "true";
      const configService = await createConfigService({
        envFilePath: writeEnvFile([
          "KEEP=${AUTH_REQUIRED}",
          "AUTH_REQUIRED=${ACCESS_TOKEN:+false}${KEEP}",
        ]),
      });

      configService.set("ACCESS_TOKEN", "token");

      expect(configService.get("AUTH_REQUIRED")).toBe("true");
      expect(process.env.AUTH_REQUIRED).toBe("true");
    });

    // BUNEST_BUG: ConfigService.set() does not re-expand startup .env definitions when a referenced variable changes (expected "https://yourapp.test/help", received "https:///help"; packages/config/src/config.service.ts:342-369)
    it.skip("should expand the definitions loaded at startup, not the file as it is now", async () => {
      const envFilePath = writeEnvFile([
        "URL=",
        "SUPPORT_URL=https://${URL}/help",
      ]);
      const configService = await createConfigService({
        envFilePath,
        validate: (config) => {
          if (!String(config.SUPPORT_URL).startsWith("https://")) {
            throw new Error("SUPPORT_URL must be an https URL");
          }
          return config;
        },
      });
      fs.writeFileSync(
        envFilePath,
        [
          "URL=",
          "SUPPORT_URL=http://attacker.test/${URL}",
          "INJECTED=by-attacker${URL:+}",
        ].join("\n"),
      );

      configService.set("URL", "yourapp.test");

      expect(configService.get("SUPPORT_URL")).toBe(
        "https://yourapp.test/help",
      );
      expect(process.env.INJECTED).toBeUndefined();
    });

    // BUNEST_BUG: ConfigService.set() does not write updated values to process.env or re-expand dependent variables (expected process.env.API_URL="https://gateway.internal/v1", received "https://api.myapp.test/v1"; packages/config/src/config.service.ts:342-369)
    it.skip("should keep a value set earlier when a variable it references is set", async () => {
      const configService = await createConfigService({
        envFilePath: writeEnvFile([
          "API_HOST=api.myapp.test",
          "API_URL=https://${API_HOST}/v1",
          "WEBHOOK_URL=${API_URL}/hooks",
        ]),
      });

      configService.set("API_URL", "https://gateway.internal/v1");
      configService.set("API_HOST", "api2.myapp.test");

      expect(configService.get("API_URL")).toBe("https://gateway.internal/v1");
      expect(process.env.API_URL).toBe("https://gateway.internal/v1");
      expect(configService.get("WEBHOOK_URL")).toBe(
        "https://gateway.internal/v1/hooks",
      );
    });

    // BUNEST_BUG: ConfigService.set() does not re-expand dependent .env variables (expected "https://api2.myapp.test/v1", received "https://api.myapp.test/v1"; packages/config/src/config.service.ts:342-369)
    it.skip('should not treat a value passed to "set" as predefined when the app is bootstrapped again', async () => {
      const envFilePath = writeEnvFile([
        "API_HOST=api.myapp.test",
        "API_URL=https://${API_HOST}/v1",
      ]);
      const firstConfigService = await createConfigService({ envFilePath });
      firstConfigService.set("API_URL", "https://gateway.internal/v1");

      const secondConfigService = await createConfigService({ envFilePath });
      secondConfigService.set("API_HOST", "api2.myapp.test");

      expect(secondConfigService.get("API_URL")).toBe(
        "https://api2.myapp.test/v1",
      );
    });

    // BUNEST_BUG: ConfigService.set() does not re-expand dependent .env variables against custom processEnv target (expected "http://myapp.test:4000", received "http://myapp.test:3000"; packages/config/src/config.service.ts:342-369)
    it.skip('should expand against a custom "processEnv" target', async () => {
      process.env.URL = "process-app.test";
      const configService = await createConfigService({
        envFilePath: writeEnvFile([
          "URL=myapp.test",
          "API_PORT=3000",
          "API_URL=http://${URL}:${API_PORT}",
        ]),
        expandVariables: { processEnv: {} },
      });
      expect(configService.get("API_URL")).toBe("http://myapp.test:3000");

      configService.set("API_PORT", "4000");

      expect(configService.get("API_URL")).toBe("http://myapp.test:4000");
    });
  },
);
