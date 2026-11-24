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
import { ConfigModule } from "../../../../../packages/core/src/config";
import { describeConformance, Test } from "../../../_helpers/index";

describeConformance(
  "Environment variables override",
  {
    upstreamPath: "config/tests/e2e/override-env.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let tmpDir: string;
    let envFilePath: string;
    let originalEnv: NodeJS.ProcessEnv;

    beforeAll(() => {
      tmpDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-config-override-${crypto.randomUUID()}`,
      );
      mkdirSyncPath(tmpDir);
      envFilePath = join(tmpDir, ".env.override-test");
      writeTextSync(envFilePath, "EXISTING_VAR=new_value");
    });

    afterAll(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should NOT override process.env when "override" is false', async () => {
      process.env.EXISTING_VAR = "original_value";

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath,
            override: false,
          }),
        ],
      }).compile();

      expect(process.env.EXISTING_VAR).toBe("original_value");
      await moduleRef.close();
    });

    it('should override process.env when "override" is true', async () => {
      process.env.EXISTING_VAR = "original_value";

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath,
            override: true,
          }),
        ],
      }).compile();

      expect(process.env.EXISTING_VAR).toBe("new_value");
      await moduleRef.close();
    });
  },
);
