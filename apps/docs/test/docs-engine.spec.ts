import { describe, expect, test } from "bun:test";
import { join, removePath } from "@bunest/core";
import { buildStaticSite } from "../src/build";
import { loadAllDocs } from "../src/content-loader";
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
    } finally {
      await removePath(outDir, { recursive: true, force: true });
    }
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
});
