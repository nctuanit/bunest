import type { BunPlugin } from "bun";
import { type FsWatcher, resolve, watchPath } from "@bunest/core";

const appDir = import.meta.dir;
const repoRoot = resolve(appDir, "../..");
const watch = Bun.argv.includes("--watch");

const ALIASES: Record<string, string> = {
  "@bunest/cli/analyzer": resolve(
    repoRoot,
    "packages/cli/src/analyzer/index.ts",
  ),
  "@bunest/cli": resolve(repoRoot, "packages/cli/src/index.ts"),
  "@bunest/core": resolve(repoRoot, "packages/core/src/common/index.ts"),
};

const aliasPlugin: BunPlugin = {
  name: "bunest-workspace-aliases",
  setup(build) {
    build.onResolve(
      { filter: /^@bunest\/(cli(\/analyzer)?|core)$/ },
      (args) => {
        const target = ALIASES[args.path];
        return target ? { path: target } : undefined;
      },
    );
  },
};

async function runBuild(): Promise<boolean> {
  const startedAt = performance.now();
  const result = await Bun.build({
    entrypoints: [resolve(appDir, "src/extension.ts")],
    outdir: resolve(appDir, "dist"),
    naming: "[name].[ext]",
    target: "node",
    format: "cjs",
    minify: !watch,
    sourcemap: watch ? "linked" : "none",
    external: ["vscode"],
    plugins: [aliasPlugin],
    throw: false,
  });

  if (!result.success) {
    console.error("[vscode-bunest] Build failed:");
    for (const log of result.logs) {
      console.error(" ", log.message);
    }
    return false;
  }

  const outFile = result.outputs.find((o) => o.kind === "entry-point");
  const sizeKb = outFile ? (outFile.size / 1024).toFixed(1) : "?";
  const elapsedMs = (performance.now() - startedAt).toFixed(0);
  console.log(
    `[vscode-bunest] Bundled dist/extension.js (${sizeKb} KB in ${elapsedMs}ms)`,
  );
  return true;
}

if (watch) {
  await runBuild();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let building = false;
  let rebuildPending = false;

  const triggerRebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (building) {
        rebuildPending = true;
        return;
      }
      building = true;
      try {
        await runBuild();
      } finally {
        building = false;
        if (rebuildPending) {
          rebuildPending = false;
          triggerRebuild();
        }
      }
    }, 120);
  };

  const watchers: FsWatcher[] = [];
  for (const dir of [
    resolve(appDir, "src"),
    resolve(repoRoot, "packages/cli/src"),
  ]) {
    try {
      watchers.push(
        watchPath(dir, { recursive: true }, (_event, filename) => {
          if (!filename || filename.endsWith(".ts") || filename.endsWith(".tsx")) {
            triggerRebuild();
          }
        }),
      );
    } catch {
      // Ignore optional watch directory failures
    }
  }

  const shutdown = () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[vscode-bunest] Watching for changes...");
} else {
  const ok = await runBuild();
  if (!ok) {
    process.exit(1);
  }
}
