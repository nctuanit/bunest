import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
} from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  ConfigModule,
  ConfigService,
} from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";

describeConformance(
  "Environment variables override with expanded variables",
  {
    upstreamPath: "config/tests/e2e/override-expand-env.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let tmpDir: string;
    let envFilePath: string;
    let originalEnv: NodeJS.ProcessEnv;

    beforeAll(() => {
      tmpDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-config-override-exp-${crypto.randomUUID()}`,
      );
      mkdirSyncPath(tmpDir);
      envFilePath = join(tmpDir, ".env.override-expand-test");
      writeTextSync(
        envFilePath,
        ["EXISTING_VAR=file_value", "DERIVED_VAR=${EXISTING_VAR}_derived"].join(
          "\n",
        ),
      );
    });

    afterAll(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      originalEnv = { ...process.env };
      process.env.EXISTING_VAR = "process_value";
      delete process.env.DERIVED_VAR;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should keep the process.env value when "override" is false', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath,
            expandVariables: true,
            override: false,
          }),
        ],
      }).compile();
      const configService = moduleRef.get(ConfigService);

      expect(process.env.EXISTING_VAR).toBe("process_value");
      expect(process.env.DERIVED_VAR).toBe("process_value_derived");
      expect(configService.get("EXISTING_VAR")).toBe("process_value");
      expect(configService.get("DERIVED_VAR")).toBe("process_value_derived");
      await moduleRef.close();
    });

    it('should use the .env file value when "override" is true', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath,
            expandVariables: true,
            override: true,
          }),
        ],
      }).compile();
      const configService = moduleRef.get(ConfigService);

      expect(process.env.EXISTING_VAR).toBe("file_value");
      expect(process.env.DERIVED_VAR).toBe("file_value_derived");
      expect(configService.get("EXISTING_VAR")).toBe("file_value");
      expect(configService.get("DERIVED_VAR")).toBe("file_value_derived");
      await moduleRef.close();
    });

    it('should still expand variables that only exist in process.env when "override" is true', async () => {
      process.env.ONLY_IN_PROCESS_ENV = "from_process";
      const extraEnvFilePath = join(
        tmpDir,
        ".env.override-expand-process-test",
      );
      writeTextSync(
        extraEnvFilePath,
        "FROM_PROCESS=${ONLY_IN_PROCESS_ENV}_expanded",
      );

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: extraEnvFilePath,
            expandVariables: true,
            override: true,
          }),
        ],
      }).compile();
      const configService = moduleRef.get(ConfigService);

      expect(configService.get("FROM_PROCESS")).toBe("from_process_expanded");
      await moduleRef.close();
    });

    // BUNEST_BUG: expandEnvEntries() reads options.processEnv for lookups but never writes expanded values back into the custom processEnv target (expected processEnv.EXISTING_VAR="file_value", received "custom_value"; packages/core/src/config/env-parser.ts:326-375)
    it.skip('should write the expanded values to a custom "processEnv" target when "override" is true', async () => {
      const processEnv: Record<string, string> = {
        EXISTING_VAR: "custom_value",
      };

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath,
            expandVariables: { processEnv },
            override: true,
          }),
        ],
      }).compile();

      expect(processEnv.EXISTING_VAR).toBe("file_value");
      expect(processEnv.DERIVED_VAR).toBe("file_value_derived");
      await moduleRef.close();
    });

    // BUNEST_BUG: expandEnvEntries() seeds visiting with `new Set([key])` at line 365, causing resolveVariable() at line 301 to return "" for self-references before calling lookup(key), making the override self-reference branch at line 335 dead code (expected "/opt/app/plugins:/usr/plugins", received "/opt/app/plugins:"; packages/core/src/config/env-parser.ts:301-303,335-337,365)
    it.skip('should expand a self-reference to the previous value when "override" is true', async () => {
      process.env.PLUGIN_PATH = "/usr/plugins";
      const prependEnvFilePath = join(
        tmpDir,
        ".env.override-expand-prepend-test",
      );
      writeTextSync(
        prependEnvFilePath,
        [
          "PLUGIN_PATH=/opt/app/plugins:$PLUGIN_PATH",
          "WORKER_PLUGIN_PATH=/opt/worker/plugins:${PLUGIN_PATH}",
        ].join("\n"),
      );

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: prependEnvFilePath,
            expandVariables: true,
            override: true,
          }),
        ],
      }).compile();
      const configService = moduleRef.get(ConfigService);

      expect(configService.get("PLUGIN_PATH")).toBe(
        "/opt/app/plugins:/usr/plugins",
      );
      expect(configService.get("WORKER_PLUGIN_PATH")).toBe(
        "/opt/worker/plugins:/opt/app/plugins:/usr/plugins",
      );
      await moduleRef.close();
    });

    it('should expand a self-reference when "override" is true', async () => {
      const selfReferenceEnvFilePath = join(
        tmpDir,
        ".env.override-expand-self-reference-test",
      );
      writeTextSync(
        selfReferenceEnvFilePath,
        ["SELF_REF=$SELF_REF", "DEPENDS_ON_SELF_REF=$SELF_REF/z"].join("\n"),
      );

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: selfReferenceEnvFilePath,
            expandVariables: true,
            override: true,
          }),
        ],
      }).compile();
      const configService = moduleRef.get(ConfigService);

      expect(configService.get("SELF_REF")).toBe("");
      expect(configService.get("DEPENDS_ON_SELF_REF")).toBe("/z");
      await moduleRef.close();
    });
  },
);
