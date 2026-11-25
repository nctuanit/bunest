import {
  INTRO_PAGE,
  NAV_CATEGORIES,
  normalizeBasePath,
  slugToHref,
  withBasePath,
  type FlattenedPage,
} from "./navigation";
import {
  UI_STRINGS,
  getCategoryTitle,
  getPageMeta,
  pageHrefForLang,
  withLangBase,
  type DocsLang,
} from "./i18n";
import type { CompiledPage } from "./content-loader";

function escapeHtml(str: string): string {
  return Bun.escapeHTML(str);
}

export function renderBrandLogoSvg(): string {
  // Geometric NestJS-inspired angular crest fused with Bun's iconic rounded core
  return `<svg class="bn-logo-svg" width="32" height="32" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="bn-grad" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FF3864"/>
      <stop offset="55%" stop-color="#E0234E"/>
      <stop offset="100%" stop-color="#B9153C"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="36" height="36" rx="10" fill="url(#bn-grad)"/>
  <path d="M12.5 27.5V12.5H20.8C24.2 12.5 26.4 14.1 26.4 16.7C26.4 18.4 25.3 19.6 23.6 20.1C25.8 20.6 27.2 22 27.2 24C27.2 26.4 25 27.5 21.3 27.5H12.5ZM16.3 18.7H20.1C21.7 18.7 22.6 18 22.6 16.9C22.6 15.8 21.7 15.2 20.1 15.2H16.3V18.7ZM16.3 24.7H20.7C22.5 24.7 23.4 24.1 23.4 22.9C23.4 21.7 22.4 21.1 20.6 21.1H16.3V24.7Z" fill="#FFFFFF"/>
  <circle cx="30.5" cy="10.5" r="3.2" fill="#FBBF24"/>
</svg>`;
}

export function renderSidebarNav(
  activeSlug: string,
  basePath = "",
  lang: DocsLang = "en",
): string {
  const langBase = withLangBase(basePath, lang);
  const introMeta = getPageMeta(
    INTRO_PAGE.slug,
    INTRO_PAGE.title,
    INTRO_PAGE.description,
    lang,
  );
  const introActive = activeSlug === "";
  const introLink = `<a class="bn-nav-top-link${introActive ? " is-active" : ""}" href="${withBasePath("/", langBase)}" data-spa-link data-nav-slug="">
    <span>${escapeHtml(introMeta.title)}</span>
  </a>`;

  const categoriesHtml = NAV_CATEGORIES.map((category) => {
    const containsActive = category.pages.some((p) => p.slug === activeSlug);
    const isOpen = containsActive || Boolean(category.defaultOpen);
    const catTitle = getCategoryTitle(category.id, category.title, lang);

    const links = category.pages
      .map((page) => {
        const active = page.slug === activeSlug;
        const href = slugToHref(page.slug, langBase);
        const pageMeta = getPageMeta(
          page.slug,
          page.title,
          page.description,
          lang,
        );
        const badge = page.badge
          ? `<span class="bn-nav-badge">${escapeHtml(page.badge)}</span>`
          : "";
        return `<li>
          <a class="bn-nav-link${active ? " is-active" : ""}" href="${href}" data-spa-link data-nav-slug="${escapeHtml(page.slug)}">
            <span>${escapeHtml(pageMeta.title)}</span>${badge}
          </a>
        </li>`;
      })
      .join("");

    return `<div class="bn-nav-group${isOpen ? " is-open" : ""}" data-nav-group="${escapeHtml(category.id)}">
      <button type="button" class="bn-nav-group-btn" aria-expanded="${isOpen ? "true" : "false"}">
        <span>${escapeHtml(catTitle)}</span>
        <svg class="bn-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <ul class="bn-nav-list">${links}</ul>
    </div>`;
  }).join("");

  return `${introLink}${categoriesHtml}`;
}

export function renderTocItems(page: CompiledPage): string {
  const ui = UI_STRINGS[page.lang ?? "en"];
  if (page.toc.length === 0) {
    return `<p class="bn-toc-empty">${escapeHtml(ui.noSubsections)}</p>`;
  }

  return `<ul class="bn-toc-list">${page.toc
    .map(
      (item) =>
        `<li class="bn-toc-item level-${item.level}"><a class="bn-toc-link" href="#${escapeHtml(item.id)}" data-toc-id="${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`,
    )
    .join("")}</ul>`;
}

export function renderPager(
  prev?: FlattenedPage["prev"],
  next?: FlattenedPage["next"],
  lang: DocsLang = "en",
): string {
  const ui = UI_STRINGS[lang];
  const prevHtml = prev
    ? `<a class="bn-pager-card bn-pager-prev" href="${escapeHtml(prev.href)}" data-spa-link>
        <span class="bn-pager-dir">&larr; ${escapeHtml(ui.previous)} &bull; ${escapeHtml(prev.categoryTitle)}</span>
        <strong class="bn-pager-title">${escapeHtml(prev.title)}</strong>
      </a>`
    : `<div class="bn-pager-spacer"></div>`;

  const nextHtml = next
    ? `<a class="bn-pager-card bn-pager-next" href="${escapeHtml(next.href)}" data-spa-link>
        <span class="bn-pager-dir">${escapeHtml(next.categoryTitle)} &bull; ${escapeHtml(ui.next)} &rarr;</span>
        <strong class="bn-pager-title">${escapeHtml(next.title)}</strong>
      </a>`
    : `<div class="bn-pager-spacer"></div>`;

  return `<nav class="bn-pager" aria-label="${escapeHtml(ui.paginationAriaLabel)}">${prevHtml}${nextHtml}</nav>`;
}

export function renderPageHtml(page: CompiledPage, basePath = ""): string {
  const lang: DocsLang = page.lang ?? "en";
  const ui = UI_STRINGS[lang];
  const base = normalizeBasePath(basePath);
  const langBase = withLangBase(base, lang);
  const assetUrl = (p: string) => withBasePath(p, base);
  const url = (p: string) => withBasePath(p, langBase);
  const enHref = pageHrefForLang(page.slug, "en", base);
  const viHref = pageHrefForLang(page.slug, "vi", base);
  const pageTitle =
    page.slug === ""
      ? ui.siteTitle
      : `${page.title} | ${ui.pageTitleSuffix}`;

  const badgeHtml = page.badge
    ? `<span class="bn-meta-badge">${escapeHtml(page.badge)}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet" />
  <script>
    (function() {
      try {
        var saved = localStorage.getItem('bunest-docs-theme');
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        var theme = saved || (prefersDark ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
      } catch (e) {}
    })();
  </script>
  <link rel="stylesheet" href="${assetUrl("/assets/styles.css")}" />
</head>
<body data-current-slug="${escapeHtml(page.slug)}" data-base-path="${escapeHtml(base)}" data-lang="${lang}">
  <!-- Top Header -->
  <header class="bn-header">
    <div class="bn-header-left">
      <button type="button" class="bn-icon-btn bn-menu-toggle" id="bn-menu-toggle" aria-label="${escapeHtml(ui.toggleMenu)}" aria-expanded="false">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
      <a class="bn-brand" href="${url("/")}" data-spa-link>
        ${renderBrandLogoSvg()}
        <span class="bn-brand-text">
          <span class="bn-brand-name">Bunest</span>
          <span class="bn-brand-sub">DOCS</span>
        </span>
      </a>
    </div>

    <div class="bn-header-center">
      <button type="button" class="bn-search-trigger" id="bn-search-trigger" aria-label="${escapeHtml(ui.searchTriggerLabel)}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span class="bn-search-placeholder">${escapeHtml(ui.searchPlaceholder)}</span>
        <kbd class="bn-kbd" id="bn-search-kbd">Ctrl K</kbd>
      </button>
    </div>

    <div class="bn-header-right">
      <div class="bn-lang-switch" role="group" aria-label="Language">
        <a id="bn-lang-en" class="bn-lang-btn${lang === "en" ? " is-active" : ""}" href="${escapeHtml(enHref)}" hreflang="en" title="English">EN</a>
        <a id="bn-lang-vi" class="bn-lang-btn${lang === "vi" ? " is-active" : ""}" href="${escapeHtml(viHref)}" hreflang="vi" title="Tiếng Việt">VI</a>
      </div>
      <a class="bn-header-pill" href="${url("/architecture/adrs")}" data-spa-link title="Architecture Decision Records">
        <span class="bn-pill-dot"></span>
        <span>v0.1 &bull; Bun 1.4.5+</span>
      </a>
      <button type="button" class="bn-icon-btn bn-theme-toggle" id="bn-theme-toggle" aria-label="${escapeHtml(ui.toggleTheme)}" title="${escapeHtml(ui.toggleTheme)}">
        <svg class="bn-icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        <svg class="bn-icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
      <a class="bn-icon-btn" href="${url("/ecosystem/packages")}" data-spa-link aria-label="${escapeHtml(ui.packagesLabel)}" title="${escapeHtml(ui.packagesLabel)}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
      </a>
    </div>
  </header>

  <!-- Mobile Sidebar Backdrop -->
  <div class="bn-backdrop" id="bn-backdrop" hidden></div>

  <!-- 3-Column Documentation Shell -->
  <div class="bn-shell">
    <!-- Left Navigation Sidebar -->
    <aside class="bn-sidebar" id="bn-sidebar" aria-label="${escapeHtml(ui.navAriaLabel)}">
      <div class="bn-sidebar-inner">
        <nav class="bn-nav" id="bn-nav">
          ${renderSidebarNav(page.slug, base, lang)}
        </nav>
        <div class="bn-sidebar-footer">
          <div class="bn-sidebar-runtime">
            <span class="bn-runtime-label">${escapeHtml(ui.runtimeLabel)}</span>
            <code>Bun &ge; 1.4.5</code>
          </div>
          <div class="bn-sidebar-runtime">
            <span class="bn-runtime-label">${escapeHtml(ui.decoratorsLabel)}</span>
            <code>Legacy TS</code>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main Documentation Article -->
    <main class="bn-main" id="bn-main">
      <div class="bn-article-container">
        <div class="bn-page-meta" id="bn-page-meta">
          <span class="bn-kicker" id="bn-page-kicker">${escapeHtml(page.categoryTitle)}</span>
          <span class="bn-meta-sep">&bull;</span>
          <span class="bn-reading-time" id="bn-reading-time">${page.readingMinutes} ${escapeHtml(ui.minRead)}</span>
          <span id="bn-meta-badge-slot">${badgeHtml}</span>
        </div>

        <article class="bn-content" id="bn-content">
          ${page.html}
        </article>

        <div id="bn-pager-slot">
          ${renderPager(page.prev, page.next, lang)}
        </div>

        <footer class="bn-footer">
          <div class="bn-footer-left">
            <strong>Bunest</strong> &mdash; ${escapeHtml(ui.footerTagline)}
          </div>
          <div class="bn-footer-links">
            <a href="${url("/architecture/adrs")}" data-spa-link>${escapeHtml(ui.footerAdrs)}</a>
            <a href="${url("/architecture/migration-from-nestjs")}" data-spa-link>${escapeHtml(ui.footerMigration)}</a>
            <a href="${url("/ecosystem/roadmap")}" data-spa-link>${escapeHtml(ui.footerRoadmap)}</a>
          </div>
        </footer>
      </div>
    </main>

    <!-- Right Table of Contents -->
    <aside class="bn-toc" id="bn-toc" aria-label="${escapeHtml(ui.onThisPage)}">
      <div class="bn-toc-inner">
        <div class="bn-toc-title">${escapeHtml(ui.onThisPage)}</div>
        <div id="bn-toc-slot">
          ${renderTocItems(page)}
        </div>
        <button type="button" class="bn-back-top" id="bn-back-top" hidden>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          <span>${escapeHtml(ui.backToTop)}</span>
        </button>
      </div>
    </aside>
  </div>

  <!-- Instant Command Search Modal (Cmd/Ctrl + K) -->
  <div class="bn-search-modal" id="bn-search-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(ui.searchModalLabel)}" hidden>
    <div class="bn-search-overlay" data-close-search></div>
    <div class="bn-search-dialog">
      <div class="bn-search-input-row">
        <svg class="bn-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="bn-search-input" class="bn-search-input" placeholder="${escapeHtml(ui.searchModalPlaceholder)}" autocomplete="off" spellcheck="false" />
        <button type="button" class="bn-search-esc" data-close-search>ESC</button>
      </div>
      <div class="bn-search-results" id="bn-search-results" role="listbox"></div>
      <div class="bn-search-footer">
        <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> ${escapeHtml(ui.searchNav)}</span>
        <span><kbd>&crarr;</kbd> ${escapeHtml(ui.searchOpen)}</span>
        <span><kbd>ESC</kbd> ${escapeHtml(ui.searchClose)}</span>
      </div>
    </div>
  </div>

  <script src="${assetUrl("/assets/client.js")}" defer></script>
</body>
</html>`;
}

export function renderNotFoundHtml(
  pathname: string,
  basePath = "",
  lang: DocsLang = "en",
): string {
  const ui = UI_STRINGS[lang];
  const base = normalizeBasePath(basePath);
  const langBase = withLangBase(base, lang);
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(ui.notFoundTitle)}</title>
  <link rel="stylesheet" href="${withBasePath("/assets/styles.css", base)}" />
</head>
<body>
  <div class="bn-notfound">
    <div class="bn-notfound-card">
      ${renderBrandLogoSvg()}
      <h1>404</h1>
      <p>${escapeHtml(ui.notFoundBodyPrefix)} <code>${escapeHtml(pathname)}</code>.</p>
      <a class="bn-btn bn-btn-primary" href="${withBasePath("/", langBase)}">${escapeHtml(ui.notFoundReturn)}</a>
    </div>
  </div>
</body>
</html>`;
}
