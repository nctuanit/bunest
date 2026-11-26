import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "../../packages/core/src/common/index";
import {
  buildResumeCommand,
  checkRegistryStatus,
  formatPartialPublishSummary,
  isAlreadyPublished,
  loadPublishablePackages,
  runPublish,
  topologicalOrder,
  type PkgMeta,
  type RegistryStatusReport,
} from "../../scripts/publish-packages";

const REPO_ROOT = resolve(import.meta.dir, "../..");

interface MockRegistryHandle {
  url: string;
  requests: Array<{ path: string; auth: string | null }>;
  stop: () => void;
}

function startMockRegistry(
  handler: (req: Request, url: URL) => Response,
): MockRegistryHandle {
  const requests: Array<{ path: string; auth: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      requests.push({
        path: url.pathname,
        auth: req.headers.get("authorization"),
      });
      return handler(req, url);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => {
      server.stop(true);
    },
  };
}

describe("publish-packages", () => {
  const activeServers: MockRegistryHandle[] = [];

  afterEach(() => {
    while (activeServers.length > 0) {
      activeServers.pop()!.stop();
    }
  });

  function createServer(
    handler: (req: Request, url: URL) => Response,
  ): MockRegistryHandle {
    const handle = startMockRegistry(handler);
    activeServers.push(handle);
    return handle;
  }

  describe("isAlreadyPublished", () => {
    it("returns true on 200 and false on 404", async () => {
      const server = createServer((_req, url) => {
        if (url.pathname === "/@bunest%2Fcore/0.1.0") {
          return Response.json({ name: "@bunest/core", version: "0.1.0" }, { status: 200 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      });

      expect(
        await isAlreadyPublished(server.url, "@bunest/core", "0.1.0", {
          token: "",
        }),
      ).toBe(true);
      expect(
        await isAlreadyPublished(server.url, "@bunest/http", "0.1.0", {
          token: "",
        }),
      ).toBe(false);
    });

    it("sends Authorization Bearer token when configured", async () => {
      const server = createServer(() =>
        Response.json({ ok: true }, { status: 200 }),
      );

      await isAlreadyPublished(server.url, "@bunest/core", "0.1.0", {
        token: "npm_secret_token_123",
      });

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.auth).toBe("Bearer npm_secret_token_123");
    });

    it("throws actionable errors on 401, 403, 500, and network failures", async () => {
      const server = createServer((_req, url) => {
        if (url.pathname.includes("auth401")) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (url.pathname.includes("auth403")) {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response("Internal Server Error", { status: 500 });
      });

      await expect(
        isAlreadyPublished(server.url, "@bunest/auth401", "0.1.0"),
      ).rejects.toThrow(/auth error \(HTTP 401\)/i);

      await expect(
        isAlreadyPublished(server.url, "@bunest/auth403", "0.1.0"),
      ).rejects.toThrow(/auth error \(HTTP 403\)/i);

      await expect(
        isAlreadyPublished(server.url, "@bunest/boom", "0.1.0"),
      ).rejects.toThrow(/Registry error \(HTTP 500\)/i);

      const failingFetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;

      await expect(
        isAlreadyPublished(server.url, "@bunest/core", "0.1.0", {
          fetchImpl: failingFetch,
        }),
      ).rejects.toThrow(/Network error checking @bunest\/core@0\.1\.0/i);
    });
  });

  describe("checkRegistryStatus & --status CLI", () => {
    it("reports all 19 packages present and exits 0 in --status mode", async () => {
      const ordered = topologicalOrder(await loadPublishablePackages());
      expect(ordered.length).toBe(19);
      const version = ordered[0]!.version;

      const publishedPaths = new Set(
        ordered.map(
          (p) =>
            `/${encodeURIComponent(p.name).replace("%40", "@")}/${encodeURIComponent(version)}`,
        ),
      );

      const server = createServer((_req, url) => {
        if (publishedPaths.has(url.pathname)) {
          return Response.json({ ok: true }, { status: 200 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      });

      const report = await checkRegistryStatus(ordered, server.url);
      expect(report.total).toBe(19);
      expect(report.published.length).toBe(19);
      expect(report.missing).toEqual([]);

      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "scripts/publish-packages.ts",
          "--status",
          `--registry=${server.url}`,
          `--version=v${version}`,
          "--json",
        ],
        {
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(0);
      const cliReport = JSON.parse(stdout) as RegistryStatusReport;
      expect(cliReport.total).toBe(19);
      expect(cliReport.published.length).toBe(19);
      expect(cliReport.missing).toEqual([]);
      expect(cliReport.version).toBe(version);
    });

    it("reports missing packages and exits non-zero on partial registry state", async () => {
      const ordered = topologicalOrder(await loadPublishablePackages());
      const version = ordered[0]!.version;
      const presentSet = new Set(ordered.slice(0, 5).map((p) => p.name));

      const server = createServer((_req, url) => {
        for (const name of presentSet) {
          const expected = `/${encodeURIComponent(name).replace("%40", "@")}/${encodeURIComponent(version)}`;
          if (url.pathname === expected) {
            return Response.json({ ok: true }, { status: 200 });
          }
        }
        return Response.json({ error: "not found" }, { status: 404 });
      });

      const report = await checkRegistryStatus(ordered, server.url);
      expect(report.total).toBe(19);
      expect(report.published).toEqual(ordered.slice(0, 5).map((p) => p.name));
      expect(report.missing).toEqual(ordered.slice(5).map((p) => p.name));

      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "scripts/publish-packages.ts",
          "--status",
          `--registry=${server.url}`,
          "--json",
        ],
        {
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(1);
      const cliReport = JSON.parse(stdout) as RegistryStatusReport;
      expect(cliReport.published.length).toBe(5);
      expect(cliReport.missing.length).toBe(14);
    });
  });

  describe("partial-publish checkpoint, resume formatting & post-publish verification", () => {
    it("formats checkpoint summary with published, skipped, failed, remaining, and --skip-existing resume command", () => {
      const summary = formatPartialPublishSummary({
        registry: "https://registry.npmjs.org/",
        version: "0.2.0",
        distTag: "latest",
        provenance: true,
        published: ["@bunest/core"],
        skipped: ["@bunest/common"],
        failed: {
          name: "@bunest/http",
          version: "0.2.0",
          error: "Publish command failed (1): 503 Service Unavailable",
        },
        remaining: ["@bunest/orm", "@bunest/cli"],
      });

      expect(summary).toContain("Published (1): @bunest/core");
      expect(summary).toContain("Skipped   (1): @bunest/common");
      expect(summary).toContain(
        "Failed    (1): @bunest/http@0.2.0 — Publish command failed (1): 503 Service Unavailable",
      );
      expect(summary).toContain("Remaining (2): @bunest/orm, @bunest/cli");
      expect(summary).toContain(
        buildResumeCommand({
          registry: "https://registry.npmjs.org",
          version: "0.2.0",
          distTag: "latest",
          provenance: true,
        }),
      );
      expect(summary).toContain("--skip-existing");
      expect(summary).toContain("--provenance");
    });

    it("prints checkpoint summary and rethrows on mid-loop failure in runPublish", async () => {
      const fakePkgs: PkgMeta[] = [
        {
          name: "@bunest/a",
          version: "0.1.0",
          dir: "/tmp/a",
          publishConfig: { access: "public" },
        },
        {
          name: "@bunest/b",
          version: "0.1.0",
          dir: "/tmp/b",
          publishConfig: { access: "public" },
        },
        {
          name: "@bunest/c",
          version: "0.1.0",
          dir: "/tmp/c",
          publishConfig: { access: "public" },
        },
        {
          name: "@bunest/d",
          version: "0.1.0",
          dir: "/tmp/d",
          publishConfig: { access: "public" },
        },
      ];

      const server = createServer((_req, url) => {
        if (url.pathname === "/@bunest%2Fa/0.1.0") {
          return Response.json({ ok: true }, { status: 200 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      });

      const logs: string[] = [];
      const errors: string[] = [];

      await expect(
        runPublish({
          packages: fakePkgs,
          registry: server.url,
          version: "0.1.0",
          distTag: "latest",
          skipExisting: true,
          provenance: true,
          wrapManifest: async (_dir, fn) => fn(),
          execCommand: async (_cmd, cwd) => {
            if (cwd === "/tmp/c") {
              throw new Error("simulated npm 503");
            }
          },
          log: (m) => logs.push(m),
          logError: (m) => errors.push(m),
        }),
      ).rejects.toThrow("simulated npm 503");

      expect(errors).toHaveLength(1);
      const checkpoint = errors[0]!;
      expect(checkpoint).toContain("Skipped   (1): @bunest/a");
      expect(checkpoint).toContain("Published (1): @bunest/b");
      expect(checkpoint).toContain("Failed    (1): @bunest/c@0.1.0 — simulated npm 503");
      expect(checkpoint).toContain("Remaining (1): @bunest/d");
      expect(checkpoint).toContain("--skip-existing");
    });

    it("verifies all packages are live on registry after a real publish loop completes", async () => {
      const fakePkgs: PkgMeta[] = [
        {
          name: "@bunest/a",
          version: "0.1.0",
          dir: "/tmp/a",
          publishConfig: { access: "public" },
        },
        {
          name: "@bunest/b",
          version: "0.1.0",
          dir: "/tmp/b",
          publishConfig: { access: "public" },
        },
      ];

      const live = new Set<string>();
      const server = createServer((_req, url) => {
        if (live.has(url.pathname)) {
          return Response.json({ ok: true }, { status: 200 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      });

      const result = await runPublish({
        packages: fakePkgs,
        registry: server.url,
        version: "0.1.0",
        distTag: "latest",
        wrapManifest: async (_dir, fn) => fn(),
        execCommand: async (_cmd, cwd) => {
          const pkg = fakePkgs.find((p) => p.dir === cwd)!;
          live.add(
            `/${encodeURIComponent(pkg.name).replace("%40", "@")}/${encodeURIComponent(pkg.version)}`,
          );
        },
        log: () => {},
        logError: () => {},
      });

      expect(result.published).toEqual(["@bunest/a", "@bunest/b"]);
      expect(result.remaining).toEqual([]);

      // If a package is missing after publish, post-publish verification fails loudly.
      live.delete("/@bunest%2Fb/0.1.0");
      await expect(
        runPublish({
          packages: fakePkgs,
          registry: server.url,
          version: "0.1.0",
          distTag: "latest",
          wrapManifest: async (_dir, fn) => fn(),
          execCommand: async () => {},
          log: () => {},
          logError: () => {},
        }),
      ).rejects.toThrow(/Post-publish verification failed.*@bunest\/b/);
    });
  });

  describe("dry-run packaging validation without npm credentials", () => {
    it("uses `bun pm pack --dry-run` inside wrapManifest when dryRun is true and keeps `bun publish` for real runs", async () => {
      const fakePkgs: PkgMeta[] = [
        {
          name: "@bunest/a",
          version: "0.1.0",
          dir: "/tmp/a",
          publishConfig: { access: "public" },
        },
        {
          name: "@bunest/b",
          version: "0.1.0",
          dir: "/tmp/b",
          publishConfig: { access: "public" },
        },
      ];

      const dryRunCalls: Array<{ cmd: string[]; cwd: string; wrapped: boolean }> = [];
      let inWrapper = false;

      const dryResult = await runPublish({
        packages: fakePkgs,
        registry: "https://registry.npmjs.org",
        version: "0.1.0",
        distTag: "latest",
        dryRun: true,
        provenance: true,
        wrapManifest: async (_dir, fn) => {
          inWrapper = true;
          try {
            return await fn();
          } finally {
            inWrapper = false;
          }
        },
        execCommand: async (cmd, cwd) => {
          dryRunCalls.push({ cmd, cwd, wrapped: inWrapper });
        },
        log: () => {},
        logError: () => {},
      });

      expect(dryResult.published).toEqual(["@bunest/a", "@bunest/b"]);
      expect(dryRunCalls).toEqual([
        { cmd: ["bun", "pm", "pack", "--dry-run"], cwd: "/tmp/a", wrapped: true },
        { cmd: ["bun", "pm", "pack", "--dry-run"], cwd: "/tmp/b", wrapped: true },
      ]);

      const publishCalls: Array<{ cmd: string[]; cwd: string }> = [];
      const server = createServer(() =>
        Response.json({ ok: true }, { status: 200 }),
      );

      await runPublish({
        packages: fakePkgs,
        registry: server.url,
        version: "0.1.0",
        distTag: "latest",
        dryRun: false,
        provenance: true,
        wrapManifest: async (_dir, fn) => fn(),
        execCommand: async (cmd, cwd) => {
          publishCalls.push({ cmd, cwd });
        },
        log: () => {},
        logError: () => {},
      });

      expect(publishCalls).toEqual([
        {
          cmd: [
            "bun",
            "publish",
            "--access",
            "public",
            "--tag",
            "latest",
            "--registry",
            server.url,
            "--provenance",
          ],
          cwd: "/tmp/a",
        },
        {
          cmd: [
            "bun",
            "publish",
            "--access",
            "public",
            "--tag",
            "latest",
            "--registry",
            server.url,
            "--provenance",
          ],
          cwd: "/tmp/b",
        },
      ]);
    });

    it("validates all publishable packages via `publish-packages.ts --dry-run` with zero npm auth env vars", async () => {
      const cleanEnv: Record<string, string | undefined> = { ...Bun.env };
      for (const key of Object.keys(cleanEnv)) {
        if (
          key === "NPM_TOKEN" ||
          key === "NODE_AUTH_TOKEN" ||
          key === "BUN_AUTH_TOKEN" ||
          key.toUpperCase().startsWith("NPM_CONFIG_")
        ) {
          delete cleanEnv[key];
        }
      }

      const proc = Bun.spawn(
        ["bun", "run", "scripts/publish-packages.ts", "--dry-run"],
        {
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
          env: cleanEnv,
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
      expect(stdout).toContain("bun pm pack --dry-run");
      expect(stdout).toContain("19 dry-run checked");
    }, 60_000);
  });
});
