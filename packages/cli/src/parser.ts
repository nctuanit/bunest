import type { CliFlagValue, ParsedCliArgs } from "./types";

const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "skip-install",
  "skip-git",
  "strict",
  "no-strict",
  "dry-run",
  "flat",
  "spec",
  "no-spec",
  "force",
  "minify",
  "no-minify",
  "sourcemap",
  "no-sourcemap",
  "watch",
  "watchAssets",
  "preserveWatchOutput",
  "silent",
  "deleteOutDir",
  "emit-declarations",
  "compile",
  "observe",
  "no-observe",
]);

const VALUE_FLAGS = new Set([
  "dir",
  "entry",
  "entryFile",
  "sourceRoot",
  "outdir",
  "target",
  "port",
  "sourcemap",
  "config",
  "path",
  "project",
  "exec",
  "env-file",
  "spec-file-suffix",
  "package-manager",
  "tag",
  "collection",
]);

const REPEATABLE_FLAGS = new Set(["env-file"]);

const OPTIONAL_VALUE_FLAGS = new Set(["debug", "sourcemap"]);

const DEFAULT_SHORT_FLAG_ALIASES: Readonly<Record<string, string>> = {
  h: "help",
  v: "version",
  d: "dir",
  e: "entry",
  o: "outdir",
  p: "port",
  f: "force",
  w: "watch",
  c: "config",
  s: "skip-install",
  g: "skip-git",
  t: "tag",
};

const COMMAND_SHORT_ALIASES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  start: {
    d: "debug",
    w: "watch",
    c: "config",
    p: "path",
    e: "exec",
  },
  add: {
    d: "dry-run",
    s: "skip-install",
    p: "project",
  },
  upgrade: {
    d: "dry-run",
    s: "skip-install",
    t: "tag",
    c: "collection",
  },
  update: {
    d: "dry-run",
    s: "skip-install",
    t: "tag",
    c: "collection",
  },
  build: {
    w: "watch",
    c: "config",
    p: "path",
    o: "outdir",
    e: "entry",
  },
  generate: {
    p: "project",
    d: "dir",
    f: "force",
  },
  g: {
    p: "project",
    d: "dir",
    f: "force",
  },
  new: {
    d: "dir",
    g: "skip-git",
    p: "package-manager",
    s: "skip-install",
    f: "force",
  },
  deploy: {
    d: "dry-run",
    c: "config",
    o: "outdir",
    e: "entry",
  },
};

function setFlagValue(
  flags: Record<string, CliFlagValue>,
  key: string,
  value: string | boolean,
): void {
  if (REPEATABLE_FLAGS.has(key) && typeof value === "string") {
    const existing = flags[key];
    if (Array.isArray(existing)) {
      flags[key] = [...existing, value];
    } else if (typeof existing === "string") {
      flags[key] = [existing, value];
    } else {
      flags[key] = value;
    }
    return;
  }
  flags[key] = value;
}

/**
 * Zero-dependency CLI argument parser supporting commands, positional arguments,
 * long flags (`--flag`, `--key value`, `--key=value`, `--no-spec`), repeatable
 * flags (`--env-file`), optional-value flags (`--debug`, `--sourcemap`), and
 * command-aware short aliases (`-h`, `-v`, `-w`, `-d`, `-c`, `-p`, `-f`, etc.).
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const flags: Record<string, CliFlagValue> = {};
  let command: string | undefined;
  let stopParsingFlags = false;

  const resolveShortAlias = (shortKey: string): string => {
    if (command && COMMAND_SHORT_ALIASES[command]?.[shortKey]) {
      return COMMAND_SHORT_ALIASES[command]![shortKey]!;
    }
    return DEFAULT_SHORT_FLAG_ALIASES[shortKey] ?? shortKey;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (stopParsingFlags) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      stopParsingFlags = true;
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eqIdx = body.indexOf("=");

      if (eqIdx !== -1) {
        const key = body.slice(0, eqIdx);
        const val = body.slice(eqIdx + 1);
        if (
          BOOLEAN_FLAGS.has(key) &&
          !VALUE_FLAGS.has(key) &&
          !OPTIONAL_VALUE_FLAGS.has(key)
        ) {
          if (val === "true") {
            setFlagValue(flags, key, true);
          } else if (val === "false") {
            setFlagValue(flags, key, false);
          } else {
            throw new Error(
              `Flag "--${key}" expects a boolean value ("true" or "false"), got "${val}".`,
            );
          }
        } else if (
          (key === "sourcemap" || key === "debug") &&
          (val === "true" || val === "false")
        ) {
          setFlagValue(flags, key, val === "true");
        } else {
          setFlagValue(flags, key, val);
        }
        continue;
      }

      if (body.startsWith("no-")) {
        const baseKey = body.slice(3);
        setFlagValue(flags, body, true);
        setFlagValue(flags, baseKey, false);
        continue;
      }

      if (body === "sourcemap") {
        const next = argv[i + 1];
        if (
          next !== undefined &&
          ["none", "linked", "inline", "external"].includes(next)
        ) {
          setFlagValue(flags, "sourcemap", next);
          i += 1;
        } else {
          setFlagValue(flags, "sourcemap", true);
        }
        continue;
      }

      if (body === "debug") {
        const next = argv[i + 1];
        if (
          next !== undefined &&
          !next.startsWith("-") &&
          (/^[\w.-]+:\d+$/.test(next) || /^\d+$/.test(next))
        ) {
          setFlagValue(flags, "debug", next);
          i += 1;
        } else {
          setFlagValue(flags, "debug", true);
        }
        continue;
      }

      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          throw new Error(`Flag "--${body}" requires a value.`);
        }
        setFlagValue(flags, body, next);
        i += 1;
        continue;
      }

      if (BOOLEAN_FLAGS.has(body)) {
        setFlagValue(flags, body, true);
        continue;
      }

      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        setFlagValue(flags, body, next);
        i += 1;
      } else {
        setFlagValue(flags, body, true);
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const shortKey = token.slice(1);
      const mapped = resolveShortAlias(shortKey);

      if (mapped === "debug") {
        const next = argv[i + 1];
        if (
          next !== undefined &&
          !next.startsWith("-") &&
          (/^[\w.-]+:\d+$/.test(next) || /^\d+$/.test(next))
        ) {
          setFlagValue(flags, "debug", next);
          i += 1;
        } else {
          setFlagValue(flags, "debug", true);
        }
        continue;
      }

      if (VALUE_FLAGS.has(mapped)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          throw new Error(`Flag "-${shortKey}" requires a value.`);
        }
        setFlagValue(flags, mapped, next);
        i += 1;
        continue;
      }

      setFlagValue(flags, mapped, true);
      continue;
    }

    if (command === undefined) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}
