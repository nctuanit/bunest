import {
  existsSyncPath,
  join,
  readDirSyncEntries,
} from "../../packages/core/src/common/index";

/**
 * Monorepo codemod for ADR-015 (37 -> 19 packages consolidation).
 * Rewrites all `@bunest/*` imports, relative `../packages/*` test paths,
 * `package.json` dependencies, `--external` build flags, and `engines.bun`.
 */

const IMPORT_MAP: ReadonlyArray<readonly [string, string]> = [
  // Longest / subpath-first entries MUST come before bare package entries
  ["@bunest/authentication/testing", "@bunest/security/testing"],
  ["@bunest/authentication", "@bunest/security/auth"],
  ["@bunest/authorization", "@bunest/security/authz"],
  ["@bunest/apollo", "@bunest/graphql/apollo"],
  ["@bunest/mcp/testing", "@bunest/ai/mcp/testing"],
  ["@bunest/mcp", "@bunest/ai/mcp"],
  ["@bunest/events", "@bunest/messaging/events"],
  ["@bunest/cqrs", "@bunest/messaging/cqrs"],
  ["@bunest/outbox/testing", "@bunest/messaging/outbox/testing"],
  ["@bunest/outbox/postgres", "@bunest/messaging/outbox/postgres"],
  ["@bunest/outbox/mysql", "@bunest/messaging/outbox/mysql"],
  ["@bunest/outbox", "@bunest/messaging/outbox"],
  ["@bunest/webhooks/testing", "@bunest/messaging/webhooks/testing"],
  ["@bunest/webhooks/postgres", "@bunest/messaging/webhooks/postgres"],
  ["@bunest/webhooks/mysql", "@bunest/messaging/webhooks/mysql"],
  ["@bunest/webhooks", "@bunest/messaging/webhooks"],
  ["@bunest/queues", "@bunest/jobs/queues"],
  ["@bunest/scheduler", "@bunest/jobs/scheduler"],
  ["@bunest/locks/testing", "@bunest/resilience/locks/testing"],
  ["@bunest/locks", "@bunest/resilience/locks"],
  ["@bunest/idempotency/testing", "@bunest/resilience/idempotency/testing"],
  ["@bunest/idempotency", "@bunest/resilience/idempotency"],
  ["@bunest/common", "@bunest/core"],
  ["@bunest/http-client", "@bunest/core/client"],
  ["@bunest/http", "@bunest/core/http"],
  ["@bunest/config", "@bunest/core/config"],
  ["@bunest/websockets", "@bunest/core/ws"],
  ["@bunest/i18n", "@bunest/core/i18n"],
];

const RELATIVE_PKG_SRC_MAP: ReadonlyArray<readonly [string, string]> = [
  ["packages/common/src", "packages/core/src/common"],
  ["packages/http-client/src", "packages/core/src/client"],
  ["packages/http/src", "packages/core/src/http"],
  ["packages/config/src", "packages/core/src/config"],
  ["packages/websockets/src", "packages/core/src/ws"],
  ["packages/i18n/src", "packages/core/src/i18n"],
  ["packages/authentication/src", "packages/security/src/auth-next"],
  ["packages/authorization/src", "packages/security/src/authz"],
  ["packages/apollo/src", "packages/graphql/src/apollo"],
  ["packages/mcp/src", "packages/ai/src/mcp"],
  ["packages/events/src", "packages/messaging/src/events"],
  ["packages/cqrs/src", "packages/messaging/src/cqrs"],
  ["packages/outbox/src", "packages/messaging/src/outbox"],
  ["packages/webhooks/src", "packages/messaging/src/webhooks"],
  ["packages/queues/src", "packages/jobs/src/queues"],
  ["packages/scheduler/src", "packages/jobs/src/scheduler"],
  ["packages/locks/src", "packages/resilience/src/locks"],
  ["packages/idempotency/src", "packages/resilience/src/idempotency"],
];

const PKG_NAME_MAP: Readonly<Record<string, string>> = {
  "@bunest/common": "@bunest/core",
  "@bunest/http": "@bunest/core",
  "@bunest/config": "@bunest/core",
  "@bunest/http-client": "@bunest/core",
  "@bunest/websockets": "@bunest/core",
  "@bunest/i18n": "@bunest/core",
  "@bunest/authentication": "@bunest/security",
  "@bunest/authorization": "@bunest/security",
  "@bunest/apollo": "@bunest/graphql",
  "@bunest/mcp": "@bunest/ai",
  "@bunest/events": "@bunest/messaging",
  "@bunest/cqrs": "@bunest/messaging",
  "@bunest/outbox": "@bunest/messaging",
  "@bunest/webhooks": "@bunest/messaging",
  "@bunest/queues": "@bunest/jobs",
  "@bunest/scheduler": "@bunest/jobs",
  "@bunest/locks": "@bunest/resilience",
  "@bunest/idempotency": "@bunest/resilience",
};

const CORE_SUBPATH_EXTERNALS = [
  "@bunest/core",
  "@bunest/core/common",
  "@bunest/core/http",
  "@bunest/core/config",
  "@bunest/core/client",
  "@bunest/core/ws",
  "@bunest/core/i18n",
];

const MESSAGING_SUBPATH_EXTERNALS = [
  "@bunest/messaging",
  "@bunest/messaging/events",
  "@bunest/messaging/cqrs",
  "@bunest/messaging/outbox",
  "@bunest/messaging/webhooks",
];

function walkFiles(dir: string, exts: RegExp, skipDirs: Set<string>): string[] {
  if (!existsSyncPath(dir)) return [];
  const out: string[] = [];
  for (const entry of readDirSyncEntries(dir)) {
    if (skipDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, exts, skipDirs));
    } else if (exts.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function rewriteSourceFile(filePath: string): Promise<boolean> {
  const before = await Bun.file(filePath).text();
  let after = before;

  for (const [oldSpec, newSpec] of IMPORT_MAP) {
    // Match exact string literals `"@bunest/old"` or `'@bunest/old'`
    const escaped = oldSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    after = after.replace(
      new RegExp(`(["'\`])${escaped}\\1`, "g"),
      `$1${newSpec}$1`,
    );
  }

  for (const [oldRel, newRel] of RELATIVE_PKG_SRC_MAP) {
    after = after.replaceAll(oldRel, newRel);
  }

  if (after !== before) {
    await Bun.write(filePath, after);
    return true;
  }
  return false;
}

function remapDepRecord(
  deps: Record<string, string> | undefined,
  selfName?: string,
): Record<string, string> | undefined {
  if (!deps) return undefined;
  const next: Record<string, string> = {};
  for (const [name, version] of Object.entries(deps)) {
    const mapped = PKG_NAME_MAP[name] ?? name;
    if (mapped === selfName) continue;
    next[mapped] = version;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function rewriteBuildScript(buildCmd: string, selfName?: string): string {
  // Replace each `--external <pkg>` using PKG_NAME_MAP, then deduplicate externals
  const tokens = buildCmd.split(" ");
  const out: string[] = [];
  const seenExternals = new Set<string>();
  let needsCoreSubpaths = false;
  let needsMessagingSubpaths = false;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--external" && i + 1 < tokens.length) {
      const target = tokens[++i]!;
      const mapped = PKG_NAME_MAP[target] ?? target;
      if (mapped === selfName) continue;
      if (mapped === "@bunest/core") needsCoreSubpaths = true;
      if (mapped === "@bunest/messaging") needsMessagingSubpaths = true;
      if (!seenExternals.has(mapped)) {
        seenExternals.add(mapped);
        out.push("--external", mapped);
      }
      continue;
    }
    if (tokens[i] === "&&") {
      // Flush subpaths for previous command segment
      if (needsCoreSubpaths && selfName !== "@bunest/core") {
        for (const sub of CORE_SUBPATH_EXTERNALS) {
          if (!seenExternals.has(sub)) {
            seenExternals.add(sub);
            out.push("--external", sub);
          }
        }
      }
      if (needsMessagingSubpaths && selfName !== "@bunest/messaging") {
        for (const sub of MESSAGING_SUBPATH_EXTERNALS) {
          if (!seenExternals.has(sub)) {
            seenExternals.add(sub);
            out.push("--external", sub);
          }
        }
      }
      seenExternals.clear();
      needsCoreSubpaths = false;
      needsMessagingSubpaths = false;
    }
    out.push(tokens[i]!);
  }

  if (needsCoreSubpaths && selfName !== "@bunest/core") {
    for (const sub of CORE_SUBPATH_EXTERNALS) {
      if (!seenExternals.has(sub)) {
        seenExternals.add(sub);
        out.push("--external", sub);
      }
    }
  }
  if (needsMessagingSubpaths && selfName !== "@bunest/messaging") {
    for (const sub of MESSAGING_SUBPATH_EXTERNALS) {
      if (!seenExternals.has(sub)) {
        seenExternals.add(sub);
        out.push("--external", sub);
      }
    }
  }

  return out.join(" ");
}

async function rewritePackageJson(filePath: string): Promise<boolean> {
  const before = await Bun.file(filePath).text();
  const pkg = JSON.parse(before);
  const selfName: string | undefined = pkg.name;

  if (pkg.engines?.bun) {
    pkg.engines.bun = ">=1.4.5";
  }

  const nextDeps = remapDepRecord(pkg.dependencies, selfName);
  if (pkg.dependencies) {
    if (nextDeps) pkg.dependencies = nextDeps;
    else delete pkg.dependencies;
  }
  const nextDev = remapDepRecord(pkg.devDependencies, selfName);
  if (pkg.devDependencies) {
    if (nextDev) pkg.devDependencies = nextDev;
    else delete pkg.devDependencies;
  }
  const nextPeer = remapDepRecord(pkg.peerDependencies, selfName);
  if (pkg.peerDependencies) {
    if (nextPeer) pkg.peerDependencies = nextPeer;
    else delete pkg.peerDependencies;
  }

  if (typeof pkg.scripts?.build === "string" && pkg.scripts.build.includes("bun build")) {
    pkg.scripts.build = rewriteBuildScript(pkg.scripts.build, selfName);
  }

  const after = JSON.stringify(pkg, null, 2) + "\n";
  if (after !== before) {
    await Bun.write(filePath, after);
    return true;
  }
  return false;
}

const skip = new Set(["node_modules", "dist", ".git", "codemods"]);
let modifiedCode = 0;
let modifiedPkg = 0;

for (const root of ["packages", "apps", "examples", "tests", "benchmarks", "scripts"]) {
  for (const f of walkFiles(root, /\.(ts|tsx|js|mjs)$/, skip)) {
    if (await rewriteSourceFile(f)) modifiedCode++;
  }
  for (const f of walkFiles(root, /^package\.json$/, skip)) {
    if (await rewritePackageJson(f)) modifiedPkg++;
  }
}

// Root package.json engines bump
if (await rewritePackageJson("package.json")) modifiedPkg++;

console.log(`Codemod complete: updated ${modifiedCode} source/test files and ${modifiedPkg} package.json files.`);
