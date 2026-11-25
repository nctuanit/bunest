import {
  dirname,
  ensureDir as mkdir,
  join,
  removePath as rm,
} from "@bunest/core";
import { DOCS_ROOT, loadAllDocs } from "./content-loader";
import { SUPPORTED_LANGS } from "./i18n";
import { getConfiguredBasePath, normalizeBasePath } from "./navigation";
import {
  DOCS_SITE_ORIGIN,
  renderNotFoundHtml,
  renderPageHtml,
} from "./template";

const SRC_DIR = import.meta.dirname;
const DEFAULT_DIST_DIR = join(DOCS_ROOT, "dist");

export interface BuildStaticSiteOptions {
  basePath?: string;
  outDir?: string;
  cname?: string;
}

export async function buildStaticSite(
  options: BuildStaticSiteOptions = {},
): Promise<{
  pageCount: number;
  searchEntryCount: number;
  outDir: string;
  basePath: string;
}> {
  const start = performance.now();
  const basePath = normalizeBasePath(
    options.basePath ?? getConfiguredBasePath(),
  );
  const outDir = options.outDir ?? DEFAULT_DIST_DIR;
  const cname = (options.cname ?? process.env.DOCS_CNAME ?? "").trim();

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "assets"), { recursive: true });

  // Copy styles & bundle/minify client script via Bun.build
  const cssContent = await Bun.file(join(SRC_DIR, "styles.css")).text();
  await Bun.write(join(outDir, "assets", "styles.css"), cssContent);

  const buildRes = await Bun.build({
    entrypoints: [join(SRC_DIR, "client.js")],
    outdir: join(outDir, "assets"),
    minify: true,
    target: "browser",
  });

  if (!buildRes.success) {
    throw new Error(
      `Failed to bundle client.js:\n${buildRes.logs.map((l) => l.message).join("\n")}`,
    );
  }

  let totalPages = 0;
  let totalSearchEntries = 0;
  const sitemapUrls: string[] = [];

  for (const lang of SUPPORTED_LANGS) {
    const langOutDir = lang === "en" ? outDir : join(outDir, lang);
    const dataDir = join(langOutDir, "data");
    await mkdir(dataDir, { recursive: true });

    const { pages, searchIndex } = await loadAllDocs(basePath, lang);
    totalPages += pages.size;
    totalSearchEntries += searchIndex.length;

    // Write search index JSON for this locale
    await Bun.write(
      join(dataDir, "search-index.json"),
      JSON.stringify(searchIndex),
    );

    // Pre-render every documentation page + JSON payload for SPA swaps
    for (const page of pages.values()) {
      const html = renderPageHtml(page, basePath);
      sitemapUrls.push(`${DOCS_SITE_ORIGIN}${page.href}`);

      if (page.slug === "") {
        await Bun.write(join(langOutDir, "index.html"), html);
        await Bun.write(join(dataDir, "index.json"), JSON.stringify(page));
      } else {
        const htmlTarget = join(langOutDir, page.slug, "index.html");
        const jsonTarget = join(dataDir, `${page.slug}.json`);
        await mkdir(dirname(htmlTarget), { recursive: true });
        await mkdir(dirname(jsonTarget), { recursive: true });
        await Bun.write(htmlTarget, html);
        await Bun.write(jsonTarget, JSON.stringify(page));
      }
    }
  }

  // Write sitemap.xml & robots.txt for SEO
  const lastmod = new Date().toISOString().slice(0, 10);
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls
    .map(
      (loc) =>
        `  <url><loc>${Bun.escapeHTML(loc)}</loc><lastmod>${lastmod}</lastmod></url>`,
    )
    .join("\n")}\n</urlset>\n`;
  await Bun.write(join(outDir, "sitemap.xml"), sitemapXml);

  const sitemapLoc = `${DOCS_SITE_ORIGIN}${basePath}/sitemap.xml`;
  await Bun.write(
    join(outDir, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${sitemapLoc}\n`,
  );

  // Copy root llms.txt if present so /llms.txt is served alongside the docs
  const repoRoot = dirname(dirname(DOCS_ROOT));
  const llmsSrc = Bun.file(join(repoRoot, "llms.txt"));
  if (await llmsSrc.exists()) {
    await Bun.write(join(outDir, "llms.txt"), await llmsSrc.text());
  }

  // Write 404 fallback page & GitHub Pages .nojekyll marker
  await Bun.write(
    join(outDir, "404.html"),
    renderNotFoundHtml("/404", basePath, "en"),
  );
  await Bun.write(join(outDir, ".nojekyll"), "");

  if (cname) {
    await Bun.write(join(outDir, "CNAME"), `${cname}\n`);
  }

  const elapsed = (performance.now() - start).toFixed(1);
  console.log(
    `[Bunest Docs] Built ${totalPages} pages (${SUPPORTED_LANGS.join("/")}) & ${totalSearchEntries} search sections (basePath="${basePath || "/"}") to ${outDir} in ${elapsed}ms`,
  );

  return {
    pageCount: totalPages,
    searchEntryCount: totalSearchEntries,
    outDir,
    basePath,
  };
}

if (import.meta.main) {
  await buildStaticSite();
}
