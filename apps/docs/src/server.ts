import { join, resolve } from "@bunest/core";
import { DOCS_ROOT, loadAllDocs, loadSinglePage } from "./content-loader";
import { detectLangFromPathname } from "./i18n";
import {
  getConfiguredBasePath,
  normalizeBasePath,
  normalizePathname,
} from "./navigation";
import { renderNotFoundHtml, renderPageHtml } from "./template";

const SRC_DIR = import.meta.dirname;
const DIST_DIR = join(DOCS_ROOT, "dist");
const STYLES_PATH = join(SRC_DIR, "styles.css");
const CLIENT_JS_PATH = join(SRC_DIR, "client.js");

const isStaticMode = process.argv.includes("--static");
const port = Number(process.env.PORT ?? 4321);

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": isStaticMode ? "public, max-age=300" : "no-cache",
    },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": isStaticMode ? "public, max-age=300" : "no-cache",
    },
  });
}

export function createDocsServer(
  options: { port?: number; staticMode?: boolean; basePath?: string } = {},
) {
  const listenPort = options.port ?? port;
  const serveStatic = options.staticMode ?? isStaticMode;
  const basePath = normalizeBasePath(
    options.basePath ?? getConfiguredBasePath(),
  );

  return Bun.serve({
    port: listenPort,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      let pathname = url.pathname;

      if (
        basePath &&
        (pathname === basePath || pathname.startsWith(`${basePath}/`))
      ) {
        pathname = pathname.slice(basePath.length) || "/";
      }

      // Serve pre-built static output if requested
      if (serveStatic) {
        const resolvedDistDir = resolve(DIST_DIR);
        const cleanPath = pathname === "/" ? "/index.html" : pathname;
        const candidatePaths = [
          join(DIST_DIR, cleanPath),
          join(DIST_DIR, cleanPath, "index.html"),
        ];
        for (const filePath of candidatePaths) {
          const resolvedFilePath = resolve(filePath);
          if (
            resolvedFilePath !== resolvedDistDir &&
            !resolvedFilePath.startsWith(`${resolvedDistDir}/`) &&
            !resolvedFilePath.startsWith(`${resolvedDistDir}\\`)
          ) {
            return htmlResponse(renderNotFoundHtml(pathname, basePath), 404);
          }
          const f = Bun.file(resolvedFilePath);
          if (await f.exists()) {
            return new Response(f);
          }
        }
        const notFoundFile = Bun.file(join(DIST_DIR, "404.html"));
        if (await notFoundFile.exists()) {
          return new Response(notFoundFile, { status: 404 });
        }
        return htmlResponse(renderNotFoundHtml(pathname, basePath), 404);
      }

      // Assets
      if (pathname === "/assets/styles.css") {
        return new Response(Bun.file(STYLES_PATH), {
          headers: {
            "Content-Type": "text/css; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }

      if (pathname === "/assets/client.js") {
        return new Response(Bun.file(CLIENT_JS_PATH), {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }

      // Locale-aware routing (/vi/... for Vietnamese, /... for English)
      const { lang, strippedPath } = detectLangFromPathname(pathname);

      // JSON API for Instant SPA Navigation & Search
      if (strippedPath === "/data/search-index.json") {
        const { searchIndex } = await loadAllDocs(basePath, lang);
        return jsonResponse(searchIndex);
      }

      if (strippedPath.startsWith("/data/") && strippedPath.endsWith(".json")) {
        const rawSlug = strippedPath.slice("/data/".length, -".json".length);
        const slug = rawSlug === "index" ? "" : rawSlug;
        const page = await loadSinglePage(slug, basePath, lang);
        if (!page) {
          return jsonResponse({ error: "Page not found" }, 404);
        }
        return jsonResponse(page);
      }

      // SSR HTML routes
      const slug = normalizePathname(strippedPath);
      const page = await loadSinglePage(slug, basePath, lang);
      if (!page) {
        return htmlResponse(renderNotFoundHtml(pathname, basePath, lang), 404);
      }
      return htmlResponse(renderPageHtml(page, basePath));
    },
  });
}

if (import.meta.main) {
  const server = createDocsServer();
  const shutdown = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(
    `\n  [Bunest Docs] ${isStaticMode ? "Static preview" : "Dev server"} running at ${server.url}\n`,
  );
}
