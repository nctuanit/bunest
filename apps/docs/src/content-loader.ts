import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_PAGES,
  findPageBySlug,
  normalizeBasePath,
  withBasePath,
  type FlattenedPage,
} from "./navigation";
import { renderMarkdown, type TocItem } from "./markdown";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const DOCS_ROOT = dirname(SRC_DIR);
export const CONTENT_DIR = join(DOCS_ROOT, "content");

export interface CompiledPage {
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
): Promise<{
  compiled: CompiledPage;
  searchDocs: SearchDocument[];
}> {
  const base = normalizeBasePath(basePath);
  const filePath = join(CONTENT_DIR, page.file);
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`Missing documentation markdown file: ${filePath}`);
  }

  const raw = await file.text();
  const rendered = renderMarkdown(raw, { basePath: base });
  const pageHref = withBasePath(page.href, base);

  const compiled: CompiledPage = {
    slug: page.slug,
    href: pageHref,
    title: page.title,
    description: page.description,
    categoryId: page.categoryId,
    categoryTitle: page.categoryTitle,
    badge: page.badge,
    html: rendered.html,
    toc: rendered.toc,
    readingMinutes: rendered.readingMinutes,
    prev: page.prev
      ? { ...page.prev, href: withBasePath(page.prev.href, base) }
      : undefined,
    next: page.next
      ? { ...page.next, href: withBasePath(page.next.href, base) }
      : undefined,
  };

  const keywords = (page.keywords ?? []).join(" ");
  const searchDocs: SearchDocument[] = [
    {
      id: `${page.slug || "index"}#top`,
      slug: page.slug,
      href: pageHref,
      title: page.title,
      categoryTitle: page.categoryTitle,
      headingId: "",
      headingText: page.title,
      keywords,
      snippet: page.description,
    },
  ];

  for (const sec of rendered.sections) {
    if (!sec.headingId || sec.headingText === page.title) continue;
    searchDocs.push({
      id: `${page.slug || "index"}#${sec.headingId}`,
      slug: page.slug,
      href: `${pageHref}#${sec.headingId}`,
      title: page.title,
      categoryTitle: page.categoryTitle,
      headingId: sec.headingId,
      headingText: sec.headingText,
      keywords,
      snippet: sec.content.slice(0, 260),
    });
  }

  return { compiled, searchDocs };
}

export async function loadAllDocs(basePath = ""): Promise<DocsSiteData> {
  const pages = new Map<string, CompiledPage>();
  const searchIndex: SearchDocument[] = [];

  const results = await Promise.all(
    ALL_PAGES.map((p) => compilePage(p, basePath)),
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
): Promise<CompiledPage | undefined> {
  const meta = findPageBySlug(slug);
  if (!meta) return undefined;
  const { compiled } = await compilePage(meta, basePath);
  return compiled;
}
