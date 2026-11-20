import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_ROOT, loadAllDocs } from "./content-loader";
import { getConfiguredBasePath, normalizeBasePath } from "./navigation";
import { renderNotFoundHtml, renderPageHtml } from "./template";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
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
  await mkdir(join(outDir, "data"), { recursive: true });

  const { pages, searchIndex } = await loadAllDocs(basePath);

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

  // Write search index JSON
  await Bun.write(
    join(outDir, "data", "search-index.json"),
    JSON.stringify(searchIndex),
  );

  // Pre-render every documentation page + JSON payload for SPA swaps
  for (const page of pages.values()) {
    const html = renderPageHtml(page, basePath);

    if (page.slug === "") {
      await Bun.write(join(outDir, "index.html"), html);
      await Bun.write(
        join(outDir, "data", "index.json"),
        JSON.stringify(page),
      );
    } else {
      const htmlTarget = join(outDir, page.slug, "index.html");
      const jsonTarget = join(outDir, "data", `${page.slug}.json`);
      await mkdir(dirname(htmlTarget), { recursive: true });
      await mkdir(dirname(jsonTarget), { recursive: true });
      await Bun.write(htmlTarget, html);
      await Bun.write(jsonTarget, JSON.stringify(page));
    }
  }

  // Write 404 fallback page & GitHub Pages .nojekyll marker
  await Bun.write(
    join(outDir, "404.html"),
    renderNotFoundHtml("/404", basePath),
  );
  await Bun.write(join(outDir, ".nojekyll"), "");

  if (cname) {
    await Bun.write(join(outDir, "CNAME"), `${cname}\n`);
  }

  const elapsed = (performance.now() - start).toFixed(1);
  console.log(
    `[Bunest Docs] Built ${pages.size} pages & ${searchIndex.length} search sections (basePath="${basePath || "/"}") to ${outDir} in ${elapsed}ms`,
  );

  return {
    pageCount: pages.size,
    searchEntryCount: searchIndex.length,
    outDir,
    basePath,
  };
}

if (import.meta.main) {
  await buildStaticSite();
}
