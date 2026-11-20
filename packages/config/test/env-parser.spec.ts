import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandEnvEntries,
  loadEnvironmentVariables,
  parseEnvContent,
  parseEnvEntries,
} from "../src/index";

describe(".env Parser & Variable Expansion", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "bunest-config-"));
    tempDirs.push(dir);
    return dir;
  }

  test("parses comments, quotes, escaped newlines, multiline values, export prefix, and strips dangerous keys", () => {
    const raw = [
      "\uFEFF# Top comment",
      "PLAIN=hello",
      "WITH_INLINE=value # inline comment",
      "HASH_IN_VALUE=#ff00aa",
      "export EXPORTED_KEY=exported_val",
      'DOUBLE="line1\\nline2\\t\\"quoted\\""',
      "SINGLE='literal\\n$NOT_EXPANDED'",
      'MULTILINE="first line',
      'second line"',
      "BACKTICK=`tick\nline`",
      "__proto__=polluted",
      "constructor=bad",
      "prototype=bad",
    ].join("\n");

    const parsed = parseEnvContent(raw);

    expect(parsed).toEqual({
      PLAIN: "hello",
      WITH_INLINE: "value",
      HASH_IN_VALUE: "#ff00aa",
      EXPORTED_KEY: "exported_val",
      DOUBLE: 'line1\nline2\t"quoted"',
      SINGLE: "literal\\n$NOT_EXPANDED",
      MULTILINE: "first line\nsecond line",
      BACKTICK: "tick\nline",
    });
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(
      false,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("preserves literal \\$ inside single-quoted values in parseEnvContent and loadEnvironmentVariables(expandVariables: false)", () => {
    const raw = "SINGLE_DOLLAR='price=\\$100'\nDOUBLE_DOLLAR=\"price=\\$100\"\n";

    expect(parseEnvContent(raw)).toEqual({
      SINGLE_DOLLAR: "price=\\$100",
      DOUBLE_DOLLAR: "price=$100",
    });

    const dir = makeTempDir();
    const file = join(dir, ".env");
    writeFileSync(file, raw, "utf8");

    const loaded = loadEnvironmentVariables({
      envFilePath: file,
      ignoreEnvVars: true,
      expandVariables: false,
    });
    expect(loaded).toEqual({
      SINGLE_DOLLAR: "price=\\$100",
      DOUBLE_DOLLAR: "price=$100",
    });
  });

  test("expands ${VAR}, ${VAR:-default}, ${VAR-default}, $VAR, escaped \\$, and handles cycles safely", () => {
    const raw = [
      "HOST=localhost",
      "PORT=5432",
      "EMPTY=",
      'DB_URL="postgres://${HOST}:${PORT}/app"',
      "CHAINED=$DB_URL?ssl=true",
      "WITH_COLON_DEFAULT=${EMPTY:-fallback_val}",
      "WITH_DASH_EMPTY=${EMPTY-should_not_use}",
      "WITH_DASH_UNSET=${MISSING-unset_default}",
      "SINGLE_LITERAL='${HOST}'",
      'ESCAPED="price=\\$100"',
      "CYCLE_A=${CYCLE_B}",
      "CYCLE_B=${CYCLE_A}",
    ].join("\n");

    const entries = parseEnvEntries(raw);
    const expanded = expandEnvEntries(entries, { HOST: "prod.db.internal" });

    expect(expanded.DB_URL).toBe("postgres://prod.db.internal:5432/app");
    expect(expanded.CHAINED).toBe(
      "postgres://prod.db.internal:5432/app?ssl=true",
    );
    expect(expanded.WITH_COLON_DEFAULT).toBe("fallback_val");
    expect(expanded.WITH_DASH_EMPTY).toBe("");
    expect(expanded.WITH_DASH_UNSET).toBe("unset_default");
    expect(expanded.SINGLE_LITERAL).toBe("${HOST}");
    expect(expanded.ESCAPED).toBe("price=$100");
    expect(expanded.CYCLE_A).toBe("");
    expect(expanded.CYCLE_B).toBe("");
  });

  test("applies precedence: runtime env > earlier envFilePath > later envFilePath", () => {
    const dir = makeTempDir();
    const baseEnv = join(dir, ".env");
    const localEnv = join(dir, ".env.local");

    writeFileSync(
      baseEnv,
      "APP_NAME=base\nPORT=3000\nBASE_ONLY=yes\nURL=http://localhost:${PORT}\n",
    );
    writeFileSync(localEnv, "APP_NAME=local\nPORT=4000\nLOCAL_ONLY=yes\n");

    const loaded = loadEnvironmentVariables({
      envFilePath: [localEnv, baseEnv, join(dir, ".env.missing")],
      expandVariables: true,
      envSource: { APP_NAME: "from-process-env" },
    });

    expect(loaded.APP_NAME).toBe("from-process-env");
    expect(loaded.PORT).toBe("4000");
    expect(loaded.BASE_ONLY).toBe("yes");
    expect(loaded.LOCAL_ONLY).toBe("yes");
    expect(loaded.URL).toBe("http://localhost:4000");

    // ignoreEnvVars: true ignores runtime env
    const noRuntime = loadEnvironmentVariables({
      envFilePath: [localEnv, baseEnv],
      ignoreEnvVars: true,
      envSource: { APP_NAME: "ignored" },
    });
    expect(noRuntime.APP_NAME).toBe("local");

    // ignoreEnvFile: true skips files
    const noFiles = loadEnvironmentVariables({
      envFilePath: [localEnv, baseEnv],
      ignoreEnvFile: true,
      envSource: { ONLY_RUNTIME: "1" },
    });
    expect(noFiles).toEqual({ ONLY_RUNTIME: "1" });
  });
});
