import { dirname, join } from "@bunest/core";
import {
  ALL_PAGES,
  findPageBySlug,
  normalizeBasePath,
  withBasePath,
  type FlattenedPage,
} from "./navigation";
import {
  getCategoryTitle,
  getPageMeta,
  withLangBase,
  type DocsLang,
} from "./i18n";
import { renderMarkdown, type TocItem } from "./markdown";

const SRC_DIR = import.meta.dirname;
export const DOCS_ROOT = dirname(SRC_DIR);
export const CONTENT_DIR = join(DOCS_ROOT, "content");
export const CONTENT_VI_DIR = join(DOCS_ROOT, "content-vi");

export function getContentDir(lang: DocsLang = "en"): string {
  return lang === "vi" ? CONTENT_VI_DIR : CONTENT_DIR;
}

export interface CompiledPage {
  lang: DocsLang;
  slug: string;
  href: string;
  title: string;
  description: string;
  categoryId: string;
  categoryTitle: string;
  badge?: string;
  html: string;
  toc: TocItem[];
  readingMinutes: number;
  prev?: FlattenedPage["prev"];
  next?: FlattenedPage["next"];
}

export interface SearchDocument {
  id: string;
  slug: string;
  href: string;
  title: string;
  categoryTitle: string;
  headingId: string;
  headingText: string;
  keywords: string;
  snippet: string;
}

export interface DocsSiteData {
  pages: Map<string, CompiledPage>;
  searchIndex: SearchDocument[];
}

export async function compilePage(
  page: FlattenedPage,
  basePath = "",
  lang: DocsLang = "en",
): Promise<{
  compiled: CompiledPage;
  searchDocs: SearchDocument[];
}> {
  const base = normalizeBasePath(basePath);
  const langBase = withLangBase(base, lang);
  const contentDir = getContentDir(lang);
  const primaryPath = join(contentDir, page.file);
  const primaryFile = Bun.file(primaryPath);
  const exists = await primaryFile.exists();
  if (!exists) {
    throw new Error(`Missing documentation markdown file: ${primaryPath}`);
  }

  const raw = await primaryFile.text();
  const rendered = renderMarkdown(raw, { basePath: langBase });
  const pageHref = withBasePath(page.href, langBase);
  const meta = getPageMeta(page.slug, page.title, page.description, lang);
  const categoryTitle = getCategoryTitle(
    page.categoryId,
    page.categoryTitle,
    lang,
  );

  const localizeAdjacent = (
    adj: FlattenedPage["prev"],
  ): FlattenedPage["prev"] => {
    if (!adj) return undefined;
    const adjPage = findPageBySlug(adj.href);
    if (!adjPage) {
      return { ...adj, href: withBasePath(adj.href, langBase) };
    }
    const adjMeta = getPageMeta(
      adjPage.slug,
      adjPage.title,
      adjPage.description,
      lang,
    );
    return {
      title: adjMeta.title,
      href: withBasePath(adj.href, langBase),
      categoryTitle: getCategoryTitle(
        adjPage.categoryId,
        adjPage.categoryTitle,
        lang,
      ),
    };
  };

  const compiled: CompiledPage = {
    lang,
    slug: page.slug,
    href: pageHref,
    title: meta.title,
    description: meta.description,
    categoryId: page.categoryId,
    categoryTitle,
    badge: page.badge,
    html: rendered.html,
    toc: rendered.toc,
    readingMinutes: rendered.readingMinutes,
    prev: localizeAdjacent(page.prev),
    next: localizeAdjacent(page.next),
  };

  const keywords = (page.keywords ?? []).join(" ");
  const searchDocs: SearchDocument[] = [
    {
      id: `${page.slug || "index"}#top`,
      slug: page.slug,
      href: pageHref,
      title: meta.title,
      categoryTitle,
      headingId: "",
      headingText: meta.title,
      keywords,
      snippet: meta.description,
    },
  ];

  for (const sec of rendered.sections) {
    if (!sec.headingId || sec.headingText === meta.title) continue;
    searchDocs.push({
      id: `${page.slug || "index"}#${sec.headingId}`,
      slug: page.slug,
      href: `${pageHref}#${sec.headingId}`,
      title: meta.title,
      categoryTitle,
      headingId: sec.headingId,
      headingText: sec.headingText,
      keywords,
      snippet: sec.content.slice(0, 260),
    });
  }

  return { compiled, searchDocs };
}

export async function loadAllDocs(
  basePath = "",
  lang: DocsLang = "en",
): Promise<DocsSiteData> {
  const pages = new Map<string, CompiledPage>();
  const searchIndex: SearchDocument[] = [];

  const results = await Promise.all(
    ALL_PAGES.map((p) => compilePage(p, basePath, lang)),
  );
  for (const { compiled, searchDocs } of results) {
    pages.set(compiled.slug, compiled);
    searchIndex.push(...searchDocs);
  }

  return { pages, searchIndex };
}

export async function loadSinglePage(
  slug: string,
  basePath = "",
  lang: DocsLang = "en",
): Promise<CompiledPage | undefined> {
  const meta = findPageBySlug(slug);
  if (!meta) return undefined;
  const { compiled } = await compilePage(meta, basePath, lang);
  return compiled;
}
