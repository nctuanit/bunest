import { describe, expect, it } from "bun:test";
import {
  CLI_VERSION,
  HELP_TEXT,
  formatEnvironmentInfo,
  getEnvironmentInfo,
  parseCliArgs,
  parseSchematicName,
  runCli,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  validateProjectName,
  type CliIO,
} from "../src";

function createCapturedIO(cwd?: string): {
  io: CliIO;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    },
  };
}

describe("CLI Parser, Naming Utilities, and Info/Help/Version", () => {
  it("parses commands, positionals, long/short flags, negated flags, and -- terminator", () => {
    expect(
      parseCliArgs([
        "g",
        "--flat",
        "controller",
        "user-profile",
        "--dir",
        "src/features",
        "--no-spec",
        "--dry-run",
      ]),
    ).toEqual({
      command: "g",
      positionals: ["controller", "user-profile"],
      flags: {
        flat: true,
        dir: "src/features",
        "no-spec": true,
        spec: false,
        "dry-run": true,
      },
    });

    expect(
      parseCliArgs([
        "build",
        "--entry=src/server.ts",
        "-o",
        "build-out",
        "--minify",
        "--sourcemap",
        "inline",
      ]),
    ).toEqual({
      command: "build",
      positionals: [],
      flags: {
        entry: "src/server.ts",
        outdir: "build-out",
        minify: true,
        sourcemap: "inline",
      },
    });

    expect(parseCliArgs(["build", "--sourcemap"])).toEqual({
      command: "build",
      positionals: [],
      flags: { sourcemap: true },
    });

    expect(
      parseCliArgs([
        "g",
        "controller",
        "users",
        "--flat=true",
        "--spec=false",
        "--dry-run=true",
      ]),
    ).toEqual({
      command: "g",
      positionals: ["controller", "users"],
      flags: { flat: true, spec: false, "dry-run": true },
    });

    expect(() =>
      parseCliArgs(["g", "controller", "users", "--flat=maybe"]),
    ).toThrow(/expects a boolean value/);

    expect(parseCliArgs(["new", "my-app", "--", "--literal"])).toEqual({
      command: "new",
      positionals: ["my-app", "--literal"],
      flags: {},
    });

    expect(() => parseCliArgs(["new", "my-app", "--dir"])).toThrow(
      /Flag "--dir" requires a value/,
    );
    expect(() => parseCliArgs(["dev", "-p"])).toThrow(
      /Flag "-p" requires a value/,
    );
  });

  it("converts identifiers across kebab-case, PascalCase, and camelCase", () => {
    expect(toKebabCase("userProfile")).toBe("user-profile");
    expect(toKebabCase("UserProfile")).toBe("user-profile");
    expect(toKebabCase("user_profile")).toBe("user-profile");
    expect(toKebabCase("HTMLParser")).toBe("html-parser");
    expect(toPascalCase("user-profile")).toBe("UserProfile");
    expect(toPascalCase("user_profile")).toBe("UserProfile");
    expect(toCamelCase("user-profile")).toBe("userProfile");
    expect(toCamelCase("UserProfile")).toBe("userProfile");
  });

  it("strictly validates project names and schematic names against path traversal", () => {
    expect(validateProjectName("my-bunest-app")).toBe("my-bunest-app");
    expect(validateProjectName("api_v2.0")).toBe("api_v2.0");

    for (const bad of [
      "",
      "   ",
      "../escape",
      "..\\escape",
      "foo/bar",
      "foo\\bar",
      ".hidden",
      "-leading-dash",
      "bad name",
      "evil\0name",
    ]) {
      expect(() => validateProjectName(bad)).toThrow();
    }

    expect(parseSchematicName("admin/userProfile")).toEqual({
      subDir: "admin",
      rawName: "userProfile",
      kebab: "user-profile",
      pascal: "UserProfile",
      camel: "userProfile",
    });

    for (const bad of [
      "",
      "../users",
      "users/../secret",
      "/etc/passwd",
      "C:/windows/system",
      "users//profile",
      "123invalid",
    ]) {
      expect(() => parseSchematicName(bad)).toThrow();
    }
  });

  it("handles --help, -h, --version, -v, info, and unknown commands via runCli", async () => {
    const helpCap = createCapturedIO();
    const helpRes = await runCli(["--help"], helpCap.io);
    expect(helpRes.exitCode).toBe(0);
    expect(helpCap.stdout.join("\n")).toBe(HELP_TEXT);

    const shortHelpCap = createCapturedIO();
    expect((await runCli(["-h"], shortHelpCap.io)).exitCode).toBe(0);

    const verCap = createCapturedIO();
    const verRes = await runCli(["--version"], verCap.io);
    expect(verRes.exitCode).toBe(0);
    expect(verCap.stdout).toEqual([`v${CLI_VERSION}`]);

    const shortVerCap = createCapturedIO();
    expect((await runCli(["-v"], shortVerCap.io)).exitCode).toBe(0);
    expect(shortVerCap.stdout).toEqual([`v${CLI_VERSION}`]);

    const infoCap = createCapturedIO();
    const infoRes = await runCli(["info"], infoCap.io);
    expect(infoRes.exitCode).toBe(0);
    const envInfo = getEnvironmentInfo();
    expect(envInfo.bunestVersion).toBe(CLI_VERSION);
    expect(envInfo.bunVersion).toBe(Bun.version);
    expect(envInfo.cpuCores).toBeGreaterThan(0);
    expect(envInfo.totalMemoryBytes).toBeGreaterThan(0);
    expect(infoCap.stdout.join("\n")).toContain(`v${Bun.version}`);
    expect(formatEnvironmentInfo(envInfo)).toContain(envInfo.platform);

    const unknownCap = createCapturedIO();
    const unknownRes = await runCli(["unknown-cmd"], unknownCap.io);
    expect(unknownRes.exitCode).toBe(1);
    expect(unknownCap.stderr.join("\n")).toContain(
      'Unknown command "unknown-cmd"',
    );

    const missingNewCap = createCapturedIO();
    expect((await runCli(["new"], missingNewCap.io)).exitCode).toBe(1);
    expect(missingNewCap.stderr.join("\n")).toContain("<project-name>");

    const missingGenCap = createCapturedIO();
    expect((await runCli(["g", "controller"], missingGenCap.io)).exitCode).toBe(
      1,
    );
    expect(missingGenCap.stderr.join("\n")).toContain("<schematic> <name>");
  });
});
