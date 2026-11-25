import {
  existsSyncPath,
  join,
  readTextSync,
  writeTextSync,
} from "@bunest/core";
import type { CliIO } from "../types";

const CONFIG_CANDIDATES = [
  "bunest.json",
  ".bunestrc.json",
  "nest-cli.json",
  ".nest-cli.json",
] as const;

export function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      if (i < raw.length) out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function hasJsoncComments(raw: string): boolean {
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "/" && (next === "/" || next === "*")) {
      return true;
    }
  }
  return false;
}

function findMatchingObjectBrace(source: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function replaceJsoncObjectProperty(
  raw: string,
  propName: string,
  newValue: Record<string, unknown>,
  indent = "  ",
): string | undefined {
  const regex = new RegExp(`"${propName}"\\s*:\\s*\\{`);
  const match = regex.exec(raw);
  if (!match) return undefined;
  const openIdx = match.index + match[0].length - 1;
  const closeIdx = findMatchingObjectBrace(raw, openIdx);
  if (closeIdx === -1) return undefined;

  const formatted = JSON.stringify(newValue, null, 2)
    .split("\n")
    .map((line, idx) => (idx === 0 ? line : `${indent}${line}`))
    .join("\n");

  return raw.slice(0, openIdx) + formatted + raw.slice(closeIdx + 1);
}

function sortRecord<T>(obj: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key]!;
  }
  return sorted;
}

export function updateMonorepoConfig(params: {
  readonly cwd: string;
  readonly name: string;
  readonly type: "application" | "library";
  readonly rootDir: string;
  readonly io?: CliIO;
}): void {
  const { cwd, name, type, rootDir, io } = params;

  const activeConfigName = CONFIG_CANDIDATES.find((candidate) =>
    existsSyncPath(join(cwd, candidate)),
  );

  if (!activeConfigName && existsSyncPath(join(cwd, "nest.json"))) {
    io?.stderr(
      'Warning: Legacy configuration file "nest.json" is ignored. Creating "bunest.json".',
    );
  }

  const configPath = join(cwd, activeConfigName ?? "bunest.json");
  const projectRoot = `${rootDir}/${name}`;
  const projectEntry =
    type === "library"
      ? {
          type: "library",
          root: projectRoot,
          entryFile: "index",
          sourceRoot: `${projectRoot}/src`,
          compilerOptions: {
            tsConfigPath: `${projectRoot}/tsconfig.lib.json`,
          },
        }
      : {
          type: "application",
          root: projectRoot,
          entryFile: "main",
          sourceRoot: `${projectRoot}/src`,
          compilerOptions: {
            tsConfigPath: `${projectRoot}/tsconfig.app.json`,
          },
        };

  if (existsSyncPath(configPath)) {
    const raw = readTextSync(configPath);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    const existingProjects =
      parsed.projects && typeof parsed.projects === "object"
        ? (parsed.projects as Record<string, unknown>)
        : {};
    const sortedProjects = sortRecord({
      ...existingProjects,
      [name]: projectEntry,
    });

    if (hasJsoncComments(raw)) {
      const updated = replaceJsoncObjectProperty(
        raw,
        "projects",
        sortedProjects,
        "  ",
      );
      if (updated) {
        writeTextSync(configPath, updated);
        return;
      }
    }

    const nextConfig: Record<string, unknown> = {
      ...parsed,
      ...(type === "application" ? { monorepo: true } : {}),
      projects: sortedProjects,
    };
    writeTextSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
    return;
  }

  const freshConfig: Record<string, unknown> = {
    collection: "@bunest/schematics",
    sourceRoot: "src",
    ...(type === "application" ? { monorepo: true } : {}),
    compilerOptions: {
      deleteOutDir: true,
    },
    projects: {
      [name]: projectEntry,
    },
  };
  writeTextSync(configPath, `${JSON.stringify(freshConfig, null, 2)}\n`);
}

export function updateTsconfigForLibrary(params: {
  readonly cwd: string;
  readonly name: string;
  readonly rootDir: string;
  readonly prefix?: string;
}): void {
  const tsconfigPath = join(params.cwd, "tsconfig.json");
  if (!existsSyncPath(tsconfigPath)) return;

  const raw = readTextSync(tsconfigPath);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
  } catch {
    return;
  }

  const prefix = params.prefix ?? "@app";
  const aliasBase = `${prefix}/${params.name}`;
  const compilerOptions =
    parsed.compilerOptions && typeof parsed.compilerOptions === "object"
      ? (parsed.compilerOptions as Record<string, unknown>)
      : {};
  const existingPaths =
    compilerOptions.paths && typeof compilerOptions.paths === "object"
      ? (compilerOptions.paths as Record<string, string[]>)
      : {};

  const sortedPaths = sortRecord({
    ...existingPaths,
    [aliasBase]: [`./${params.rootDir}/${params.name}/src`],
    [`${aliasBase}/*`]: [`./${params.rootDir}/${params.name}/src/*`],
  });

  if (hasJsoncComments(raw)) {
    const updated = replaceJsoncObjectProperty(
      raw,
      "paths",
      sortedPaths,
      "    ",
    );
    if (updated) {
      writeTextSync(tsconfigPath, updated);
      return;
    }
  }

  const nextTsconfig = {
    ...parsed,
    compilerOptions: {
      ...compilerOptions,
      paths: sortedPaths,
    },
  };
  writeTextSync(tsconfigPath, `${JSON.stringify(nextTsconfig, null, 2)}\n`);
}

export function updateTsconfigForSubApp(params: {
  readonly cwd: string;
  readonly name: string;
  readonly rootDir: string;
}): void {
  const tsconfigPath = join(params.cwd, "tsconfig.json");
  if (!existsSyncPath(tsconfigPath)) return;

  const raw = readTextSync(tsconfigPath);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
  } catch {
    return;
  }

  const refPath = `./${params.rootDir}/${params.name}/tsconfig.app.json`;
  const existingRefs = Array.isArray(parsed.references)
    ? (parsed.references as Array<{ path: string }>)
    : [];
  const nextRefs = existingRefs.some((r) => r.path === refPath)
    ? existingRefs
    : [...existingRefs, { path: refPath }];

  const nextTsconfig: Record<string, unknown> = {
    ...parsed,
    files: [],
    references: nextRefs,
  };
  delete nextTsconfig.include;

  writeTextSync(tsconfigPath, `${JSON.stringify(nextTsconfig, null, 2)}\n`);

  const specTsconfigPath = join(params.cwd, "tsconfig.spec.json");
  if (!existsSyncPath(specTsconfigPath)) {
    const specTsconfig = {
      extends: "./tsconfig.json",
      compilerOptions: {
        types: ["bun"],
      },
      include: ["**/*.spec.ts", "**/*.test.ts"],
    };
    writeTextSync(
      specTsconfigPath,
      `${JSON.stringify(specTsconfig, null, 2)}\n`,
    );
  }
}
