import { describe, expect, test } from "bun:test";
import { dirname, join, removePath } from "@bunest/core";
import { buildStaticSite } from "../src/build";
import { DOCS_ROOT, loadAllDocs } from "../src/content-loader";
import { renderMarkdown } from "../src/markdown";
import { ALL_PAGES, findPageBySlug } from "../src/navigation";
import { createDocsServer } from "../src/server";
import { renderPageHtml } from "../src/template";

describe("@bunest/docs engine", () => {
  test("loads and compiles every navigation page without missing files", async () => {
    const { pages, searchIndex } = await loadAllDocs();

    expect(pages.size).toBe(ALL_PAGES.length);
    expect(pages.size).toBeGreaterThanOrEqual(25);
    expect(searchIndex.length).toBeGreaterThan(pages.size);

    for (const meta of ALL_PAGES) {
      const compiled = pages.get(meta.slug);
      expect(compiled).toBeDefined();
      expect(compiled!.html.length).toBeGreaterThan(200);
      expect(compiled!.title).toBe(meta.title);
    }
  });

  test("renders NestJS-style @@filename, @@switch tabs, and callouts", () => {
    const sample = [
      "# Sample Page",
      "",
      "> info **Hint** Helpful note here.",
      "",
      "@@filename(demo.controller.ts)",
      "@@tab(Bunest)",
      "```ts",
      '@Controller("demo")',
      "export class DemoController {}",
      "```",
      "@@switch",
      "@@tab(JSON)",
      "```json",
      '{ "ok": true }',
      "```",
    ].join("\n");

    const rendered = renderMarkdown(sample);

    expect(rendered.html).toContain("bn-callout-info");
    expect(rendered.html).toContain("demo.controller.ts");
    expect(rendered.html).toContain("bn-code-tabs");
    expect(rendered.html).toContain("tok-decorator");
    expect(rendered.html).toContain(">Bunest</button>");
    expect(rendered.html).toContain(">JSON</button>");
  });

  test("embeds interactive 11-stage pipeline widget on execution-pipeline page", async () => {
    const { pages } = await loadAllDocs();
    const page = pages.get("architecture/execution-pipeline");
    expect(page).toBeDefined();
    expect(page!.html).toContain("bn-pipeline-widget");
    expect(page!.html).toContain("data-pipeline-stages");
  });

  test("all internal markdown links resolve to valid documentation pages", async () => {
    const { pages } = await loadAllDocs();
    const broken: string[] = [];
    const hrefRegex = /href="(\/[^"#?]*)/g;

    for (const page of pages.values()) {
      for (const match of page.html.matchAll(hrefRegex)) {
        const target = match[1]!;
        if (target.startsWith("/assets/") || target.startsWith("/data/")) {
          continue;
        }
        if (!findPageBySlug(target)) {
          broken.push(`${page.href} -> ${target}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  test("renders complete SSR HTML shell with sidebar, TOC, and search modal", async () => {
    const { pages } = await loadAllDocs();
    const intro = pages.get("")!;
    const html = renderPageHtml(intro);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("bn-sidebar");
    expect(html).toContain("bn-search-modal");
    expect(html).toContain("bn-hero-banner");
    expect(html).toContain("/assets/styles.css");
    expect(html).toContain("/assets/client.js");
  });

  test("serves SSR routes, SPA JSON payloads, search index, assets, and 404 via Bun.serve", async () => {
    const server = createDocsServer({ port: 0, staticMode: false });
    try {
      const base = server.url.toString().replace(/\/$/, "");

      const [homeRes, ctrlRes, jsonRes, searchRes, cssRes, jsRes, notFoundRes] =
        await Promise.all([
          fetch(`${base}/`),
          fetch(`${base}/overview/controllers`),
          fetch(`${base}/data/overview/controllers.json`),
          fetch(`${base}/data/search-index.json`),
          fetch(`${base}/assets/styles.css`),
          fetch(`${base}/assets/client.js`),
          fetch(`${base}/does-not-exist`),
        ]);

      expect(homeRes.status).toBe(200);
      expect(await homeRes.text()).toContain("Bunest");

      expect(ctrlRes.status).toBe(200);
      expect(await ctrlRes.text()).toContain("@Controller");

      expect(jsonRes.status).toBe(200);
      const pageJson = (await jsonRes.json()) as {
        slug: string;
        title: string;
        toc: unknown[];
      };
      expect(pageJson.slug).toBe("overview/controllers");
      expect(pageJson.title).toBe("Controllers");
      expect(pageJson.toc.length).toBeGreaterThan(3);

      expect(searchRes.status).toBe(200);
      const idx = (await searchRes.json()) as unknown[];
      expect(idx.length).toBeGreaterThan(50);

      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get("content-type")).toContain("text/css");

      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get("content-type")).toContain(
        "application/javascript",
      );

      expect(notFoundRes.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("builds GitHub Pages static bundle with custom basePath, .nojekyll, and prefixed links/assets", async () => {
    const tmpDir = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
    const outDir = join(
      tmpDir,
      `bunest-docs-ghpages-${Date.now()}-${crypto.randomUUID()}`,
    );
    try {
      const result = await buildStaticSite({
        basePath: "/bunest",
        outDir,
      });

      expect(result.basePath).toBe("/bunest");
      expect(result.pageCount).toBe(ALL_PAGES.length * 2);

      expect(await Bun.file(join(outDir, ".nojekyll")).exists()).toBe(true);
      expect(await Bun.file(join(outDir, "404.html")).exists()).toBe(true);
      expect(await Bun.file(join(outDir, "assets", "client.js")).exists()).toBe(
        true,
      );
      expect(
        await Bun.file(join(outDir, "assets", "styles.css")).exists(),
      ).toBe(true);

      const indexHtml = await Bun.file(join(outDir, "index.html")).text();
      expect(indexHtml).toContain('data-base-path="/bunest"');
      expect(indexHtml).toContain('data-lang="en"');
      expect(indexHtml).toContain('href="/bunest/vi/"');
      expect(indexHtml).toContain('href="/bunest/assets/styles.css"');
      expect(indexHtml).toContain('src="/bunest/assets/client.js"');
      expect(indexHtml).toContain('href="/bunest/overview/first-steps"');
      expect(indexHtml).toContain('href="/bunest/overview/controllers"');

      const viIndexHtml = await Bun.file(
        join(outDir, "vi", "index.html"),
      ).text();
      expect(viIndexHtml).toContain('lang="vi"');
      expect(viIndexHtml).toContain('data-lang="vi"');
      expect(viIndexHtml).toContain('href="/bunest/assets/styles.css"');
      expect(viIndexHtml).toContain('href="/bunest/vi/overview/first-steps"');
      expect(viIndexHtml).toContain('href="/bunest/"');

      const viSearchIdx = (await Bun.file(
        join(outDir, "vi", "data", "search-index.json"),
      ).json()) as Array<{ href: string }>;
      expect(viSearchIdx.length).toBeGreaterThan(50);
      for (const entry of viSearchIdx) {
        expect(entry.href.startsWith("/bunest/vi/")).toBe(true);
      }

      const searchIdx = (await Bun.file(
        join(outDir, "data", "search-index.json"),
      ).json()) as Array<{ href: string }>;
      expect(searchIdx.length).toBeGreaterThan(50);
      for (const entry of searchIdx) {
        expect(entry.href.startsWith("/bunest/")).toBe(true);
      }

      const controllersJson = (await Bun.file(
        join(outDir, "data", "overview", "controllers.json"),
      ).json()) as {
        href: string;
        prev?: { href: string };
        next?: { href: string };
      };
      expect(controllersJson.href).toBe("/bunest/overview/controllers");
      expect(controllersJson.prev?.href.startsWith("/bunest/")).toBe(true);
      expect(controllersJson.next?.href.startsWith("/bunest/")).toBe(true);

      // Verify SEO & AI artifacts: sitemap.xml, robots.txt, llms.txt
      const sitemapXml = await Bun.file(join(outDir, "sitemap.xml")).text();
      expect(sitemapXml).toContain("<urlset");
      expect(sitemapXml).toContain("/bunest/overview/decorators");
      expect(sitemapXml).toContain("/bunest/recipes/deployment");
      expect(sitemapXml).toContain("/bunest/faq/common-errors");
      expect(sitemapXml).toContain("/bunest/vi/recipes/deployment");

      const robotsTxt = await Bun.file(join(outDir, "robots.txt")).text();
      expect(robotsTxt).toContain("Sitemap:");
      expect(robotsTxt).toContain("/bunest/sitemap.xml");

      expect(await Bun.file(join(outDir, "llms.txt")).exists()).toBe(true);
    } finally {
      await removePath(outDir, { recursive: true, force: true });
    }
  });

  test("renders SEO OpenGraph/hreflang tags, breadcrumbs, Copy Markdown, and Edit on GitHub", async () => {
    const { pages } = await loadAllDocs("/bunest", "en");
    const page = pages.get("recipes/deployment")!;
    expect(page).toBeDefined();
    expect(page.rawMarkdown).toContain("# Deployment");
    expect(page.sourceFile).toBe("apps/docs/content/recipes/deployment.md");

    const html = renderPageHtml(page, "/bunest");
    expect(html).toContain('property="og:title"');
    expect(html).toContain('name="twitter:card"');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('hreflang="vi"');
    expect(html).toContain("bn-breadcrumb");
    expect(html).toContain('id="bn-copy-md"');
    expect(html).toContain('id="bn-edit-github"');
    expect(html).toContain("/edit/main/apps/docs/content/recipes/deployment.md");
    expect(html).toContain("/bunest/llms.txt");
  });

  test("loads all Vietnamese pages, rewrites internal links under /vi, and serves /vi routes", async () => {
    const { pages, searchIndex } = await loadAllDocs("", "vi");
    expect(pages.size).toBe(ALL_PAGES.length);
    expect(searchIndex.length).toBeGreaterThan(pages.size);

    const broken: string[] = [];
    const hrefRegex = /href="(\/[^"#?]*)/g;
    for (const page of pages.values()) {
      expect(page.lang).toBe("vi");
      expect(page.html.length).toBeGreaterThan(200);
      for (const match of page.html.matchAll(hrefRegex)) {
        const target = match[1]!;
        if (target.startsWith("/assets/") || target.startsWith("/data/")) {
          continue;
        }
        const stripped = target.startsWith("/vi/")
          ? target.slice(3)
          : target === "/vi"
            ? "/"
            : target;
        if (!findPageBySlug(stripped)) {
          broken.push(`${page.href} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);

    const server = createDocsServer({ port: 0, staticMode: false });
    try {
      const base = server.url.toString().replace(/\/$/, "");
      const [viHome, viEx, viJson, viSearch] = await Promise.all([
        fetch(`${base}/vi/`),
        fetch(`${base}/vi/overview/exception-filters`),
        fetch(`${base}/vi/data/overview/exception-filters.json`),
        fetch(`${base}/vi/data/search-index.json`),
      ]);
      expect(viHome.status).toBe(200);
      expect(await viHome.text()).toContain('lang="vi"');
      expect(viEx.status).toBe(200);
      expect(viJson.status).toBe(200);
      const parsed = (await viJson.json()) as { lang: string; slug: string };
      expect(parsed.lang).toBe("vi");
      expect(parsed.slug).toBe("overview/exception-filters");
      expect(viSearch.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("EN and VI ecosystem/roadmap.md match canonical version, package count, Bun minimum, and have no stale claims", async () => {
    const repoRoot = dirname(dirname(DOCS_ROOT));
    const corePkg = (await Bun.file(
      join(repoRoot, "packages", "core", "package.json"),
    ).json()) as { version: string; engines?: { bun?: string } };

    const canonicalVersion = corePkg.version;
    const canonicalBunMin = (corePkg.engines?.bun ?? "").replace(/^>=\s*/, "");
    expect(canonicalVersion).toBe("0.1.0");
    expect(canonicalBunMin).toBe("1.4.5");

    const pkgGlob = new Bun.Glob("packages/*/package.json");
    const workspaceVersions: string[] = [];
    for await (const relPath of pkgGlob.scan(repoRoot)) {
      const pkg = (await Bun.file(join(repoRoot, relPath)).json()) as {
        version: string;
      };
      workspaceVersions.push(pkg.version);
    }
    const canonicalPkgCount = workspaceVersions.length;
    expect(canonicalPkgCount).toBe(19);
    expect(workspaceVersions.every((v) => v === canonicalVersion)).toBe(true);

    const enRoadmap = await Bun.file(
      join(DOCS_ROOT, "content", "ecosystem", "roadmap.md"),
    ).text();
    const viRoadmap = await Bun.file(
      join(DOCS_ROOT, "content-vi", "ecosystem", "roadmap.md"),
    ).text();

    const extractInternalLinks = (md: string): string[] =>
      [...md.matchAll(/\[[^\]]+\]\((\/[^)#?\s]+)/g)]
        .map((m) => m[1]!)
        .sort();

    for (const [label, md] of [
      ["EN", enRoadmap],
      ["VI", viRoadmap],
    ] as const) {
      expect(md, `${label} roadmap missing canonical version`).toContain(
        canonicalVersion,
      );
      expect(md, `${label} roadmap missing canonical package count`).toContain(
        String(canonicalPkgCount),
      );
      expect(md, `${label} roadmap missing canonical Bun minimum`).toContain(
        canonicalBunMin,
      );
      expect(md, `${label} roadmap missing Production Preview scope`).toContain(
        "@bunest/core",
      );
      expect(md).toContain("@bunest/validation");
      expect(md).toContain("@bunest/orm");
      expect(md).toContain("PostgreSQL");
      expect(md).toContain("@bunest/observability");

      // Current release/status sections (before Section 5 Historical Milestones) must never cite stale 35 packages or v0.8
      const beforeHistory = md.split(/^## 5\./m)[0] ?? md;
      expect(beforeHistory).not.toMatch(/\b35\s+packages?\b/i);
      expect(beforeHistory).not.toMatch(/\bv0\.8\b/i);

      // Nowhere in roadmap may v0.8 be claimed as released or completed
      expect(md).not.toMatch(
        /v0\.8[^\n]*(released|completed|done|hoàn thành|đã phát hành)/i,
      );
      expect(md).not.toMatch(
        /(released|completed|done|hoàn thành|đã phát hành)[^\n]*v0\.8/i,
      );
    }

    expect(extractInternalLinks(viRoadmap)).toEqual(
      extractInternalLinks(enRoadmap),
    );
  });

  test("EN and VI introduction.md each have a single H1, quickstart CTA, and @Get('/health') snippet", async () => {
    const extractH1s = (md: string): string[] => {
      const h1s: string[] = [];
      let inFence = false;
      for (const line of md.split(/\r?\n/)) {
        if (line.trim().startsWith("```")) {
          inFence = !inFence;
          continue;
        }
        if (!inFence && /^#\s+/.test(line)) {
          h1s.push(line.trim());
        }
      }
      return h1s;
    };

    const enIntro = await Bun.file(
      join(DOCS_ROOT, "content", "introduction.md"),
    ).text();
    const viIntro = await Bun.file(
      join(DOCS_ROOT, "content-vi", "introduction.md"),
    ).text();

    expect(extractH1s(enIntro)).toEqual([
      "# Build a TypeScript REST API on Bun",
    ]);
    expect(extractH1s(viIntro)).toEqual([
      "# Viết REST API bằng TypeScript trên Bun",
    ]);

    expect(enIntro).toContain("Run your first API");
    expect(enIntro).toContain("(/overview/first-steps)");
    expect(viIntro).toContain("Chạy API đầu tiên");
    expect(viIntro).toContain("(/overview/first-steps)");

    for (const md of [enIntro, viIntro]) {
      expect(md).toContain('@Get("/health")');
      expect(md).toContain('{ status: "ok" }');
      expect(md).toContain("curl http://localhost:3000/health");
      expect(md).toContain('{"status":"ok"}');
      expect(md).toContain("(/architecture/migration-from-nestjs)");
      expect(md).toContain("(/architecture/execution-pipeline)");
      expect(md).toContain("(/architecture/adrs)");
      expect(md).toContain("(/ecosystem/roadmap)");
    }
  });

  test("all 6 key EN/VI pages render cleanly under DOCS_BASE_PATH=/bunest with prefixed assets/links and roadmap lang toggle", async () => {
    const tmpDir = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
    const outDir = join(
      tmpDir,
      `bunest-docs-key-pages-${Date.now()}-${crypto.randomUUID()}`,
    );
    try {
      await buildStaticSite({
        basePath: "/bunest",
        outDir,
      });

      const keyPages = [
        {
          file: join(outDir, "index.html"),
          lang: "en",
          expectedPrefix: "/bunest/",
        },
        {
          file: join(outDir, "overview", "first-steps", "index.html"),
          lang: "en",
          expectedPrefix: "/bunest/",
        },
        {
          file: join(outDir, "ecosystem", "roadmap", "index.html"),
          lang: "en",
          expectedPrefix: "/bunest/",
        },
        {
          file: join(outDir, "vi", "index.html"),
          lang: "vi",
          expectedPrefix: "/bunest/vi/",
        },
        {
          file: join(outDir, "vi", "overview", "first-steps", "index.html"),
          lang: "vi",
          expectedPrefix: "/bunest/vi/",
        },
        {
          file: join(outDir, "vi", "ecosystem", "roadmap", "index.html"),
          lang: "vi",
          expectedPrefix: "/bunest/vi/",
        },
      ] as const;

      for (const entry of keyPages) {
        expect(await Bun.file(entry.file).exists(), entry.file).toBe(true);
        const html = await Bun.file(entry.file).text();
        expect(html).toContain('data-base-path="/bunest"');
        expect(html).toContain(`data-lang="${entry.lang}"`);
        expect(html).toContain('href="/bunest/assets/styles.css"');
        expect(html).toContain('src="/bunest/assets/client.js"');

        // Every internal SPA link on the page must carry the /bunest (or /bunest/vi) prefix
        const spaLinks = [
          ...html.matchAll(/href="([^"]+)"[^>]*data-spa-link/g),
        ].map((m) => m[1]!);
        expect(spaLinks.length).toBeGreaterThan(5);
        for (const href of spaLinks) {
          if (href.startsWith("#")) continue;
          expect(
            href.startsWith(entry.expectedPrefix),
            `Unprefixed SPA link ${href} in ${entry.file}`,
          ).toBe(true);
        }
      }

      // Homepage CTAs point to the localized first-steps page under /bunest
      const enHome = await Bun.file(join(outDir, "index.html")).text();
      expect(enHome).toContain("Build a TypeScript REST API on Bun");
      expect(enHome).toContain('href="/bunest/overview/first-steps"');
      expect(enHome).toContain("Run your first API");

      const viHome = await Bun.file(join(outDir, "vi", "index.html")).text();
      expect(viHome).toContain("Viết REST API bằng TypeScript trên Bun");
      expect(viHome).toContain('href="/bunest/vi/overview/first-steps"');
      expect(viHome).toContain("Chạy API đầu tiên");

      // Language toggle on both EN & VI roadmap pages preserves /ecosystem/roadmap
      const enRoadmapHtml = await Bun.file(
        join(outDir, "ecosystem", "roadmap", "index.html"),
      ).text();
      expect(enRoadmapHtml).toMatch(
        /<a\b[^>]*\bid="bn-lang-en"[^>]*\bhref="\/bunest\/ecosystem\/roadmap"/,
      );
      expect(enRoadmapHtml).toMatch(
        /<a\b[^>]*\bid="bn-lang-vi"[^>]*\bhref="\/bunest\/vi\/ecosystem\/roadmap"/,
      );

      const viRoadmapHtml = await Bun.file(
        join(outDir, "vi", "ecosystem", "roadmap", "index.html"),
      ).text();
      expect(viRoadmapHtml).toMatch(
        /<a\b[^>]*\bid="bn-lang-en"[^>]*\bhref="\/bunest\/ecosystem\/roadmap"/,
      );
      expect(viRoadmapHtml).toMatch(
        /<a\b[^>]*\bid="bn-lang-vi"[^>]*\bhref="\/bunest\/vi\/ecosystem\/roadmap"/,
      );
    } finally {
      await removePath(outDir, { recursive: true, force: true });
    }
  });
});
