/* Bunest Docs Client Runtime — SPA Navigation, Instant Search (Cmd/Ctrl+K),
   Scroll-Spy TOC, Sidebar Accordions, Theme Toggle, Code Tabs & Copy, Pipeline Inspector */

(() => {
  const pageCache = new Map();
  let searchIndex = null;
  let searchSelectedIndex = 0;
  let currentSearchMatches = [];
  let tocObserver = null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Base path & language support for GitHub Pages project sites (e.g. "/bunest", "/bunest/vi")
  const BASE_PATH = (
    document.body.getAttribute("data-base-path") || ""
  ).replace(/\/+$/, "");
  const LANG = document.body.getAttribute("data-lang") === "vi" ? "vi" : "en";
  const LANG_PREFIX = LANG === "vi" ? "/vi" : "";
  const UI =
    LANG === "vi"
      ? {
          noSubsections: "Trang này không có mục con.",
          previous: "Trang trước",
          next: "Trang tiếp",
          minRead: "phút đọc",
          copy: "Sao chép",
          copied: "Đã chép",
          copyMarkdown: "Chép Markdown",
          copiedMarkdown: "Đã chép Markdown",
          siteTitle:
            "Tài liệu | Bunest — Framework TypeScript thuần Bun theo kiến trúc NestJS",
          titleSuffix: "Tài liệu Bunest",
          paginationLabel: "Phân trang tài liệu",
        }
      : {
          noSubsections: "No subsections on this page.",
          previous: "Previous",
          next: "Next",
          minRead: "min read",
          copy: "Copy",
          copied: "Copied",
          copyMarkdown: "Copy Markdown",
          copiedMarkdown: "Copied Markdown",
          siteTitle:
            "Documentation | Bunest — A progressive Bun-native TypeScript framework",
          titleSuffix: "Bunest Documentation",
          paginationLabel: "Page pagination",
        };

  function withBase(path) {
    if (!BASE_PATH) return path;
    if (path === "/" || path === "") return `${BASE_PATH}/`;
    if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
    return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
  }

  function hrefForLang(slug, lang) {
    const prefix = lang === "vi" ? "/vi" : "";
    const raw = slug === "" ? `${prefix || ""}/` : `${prefix}/${slug}`;
    return withBase(raw);
  }

  // Platform shortcut hint
  const isMac = /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent,
  );
  const kbdEl = $("#bn-search-kbd");
  if (kbdEl) kbdEl.textContent = isMac ? "⌘K" : "Ctrl K";

  // -------------------------------------------------------------------------
  // Theme Toggle
  // -------------------------------------------------------------------------
  function toggleTheme() {
    const html = document.documentElement;
    const current =
      html.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    html.setAttribute("data-theme", next);
    try {
      localStorage.setItem("bunest-docs-theme", next);
    } catch {}
  }

  $$("[data-theme-toggle]").forEach((btn) =>
    btn.addEventListener("click", toggleTheme),
  );

  // Copy current page Markdown (for AI / sharing)
  $("#bn-copy-md")?.addEventListener("click", async () => {
    const btn = $("#bn-copy-md");
    const slug = document.body.getAttribute("data-current-slug") || "";
    const page = await fetchPageData(slug);
    const md = page?.rawMarkdown || $("#bn-content")?.innerText || "";
    try {
      await navigator.clipboard.writeText(md);
      btn?.classList.add("is-copied");
      const label = btn?.querySelector(".bn-copy-md-label");
      if (label) label.textContent = UI.copiedMarkdown;
      setTimeout(() => {
        btn?.classList.remove("is-copied");
        if (label) label.textContent = UI.copyMarkdown;
      }, 1800);
    } catch {}
  });

  // -------------------------------------------------------------------------
  // Mobile Sidebar Drawer & Body Scroll Lock
  // -------------------------------------------------------------------------
  const sidebar = $("#bn-sidebar");
  const backdrop = $("#bn-backdrop");
  const menuToggle = $("#bn-menu-toggle");
  const drawerClose = $("#bn-drawer-close");
  let sidebarLastFocused = null;
  let searchLastFocused = null;

  function syncScrollLock() {
    const sidebarOpen = Boolean(sidebar?.classList.contains("is-open"));
    const searchOpen = Boolean(searchModal && !searchModal.hidden);
    const locked = sidebarOpen || searchOpen;
    document.body.classList.toggle("bn-scroll-locked", locked);
    document.documentElement.classList.toggle("bn-scroll-locked", locked);
  }

  function closeSidebar(restoreFocus = false) {
    const wasOpen = Boolean(sidebar?.classList.contains("is-open"));
    sidebar?.classList.remove("is-open");
    if (backdrop) backdrop.hidden = true;
    menuToggle?.setAttribute("aria-expanded", "false");
    syncScrollLock();
    if (restoreFocus && wasOpen) {
      const target =
        sidebarLastFocused instanceof HTMLElement
          ? sidebarLastFocused
          : menuToggle;
      sidebarLastFocused = null;
      target?.focus();
    } else if (!wasOpen) {
      sidebarLastFocused = null;
    }
  }

  function openSidebar() {
    sidebarLastFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : menuToggle;
    sidebar?.classList.add("is-open");
    if (backdrop) backdrop.hidden = false;
    menuToggle?.setAttribute("aria-expanded", "true");
    syncScrollLock();
    if (drawerClose instanceof HTMLElement) {
      drawerClose.focus({ preventScroll: true });
    }
  }

  menuToggle?.addEventListener("click", () => {
    if (sidebar?.classList.contains("is-open")) closeSidebar(true);
    else openSidebar();
  });
  drawerClose?.addEventListener("click", () => closeSidebar(true));
  backdrop?.addEventListener("click", () => closeSidebar(true));

  const desktopMedia = window.matchMedia?.("(min-width: 961px)");
  desktopMedia?.addEventListener?.("change", (ev) => {
    if (ev.matches && sidebar?.classList.contains("is-open")) {
      closeSidebar(false);
    }
  });

  // -------------------------------------------------------------------------
  // Sidebar Category Accordions
  // -------------------------------------------------------------------------
  function initSidebarAccordions() {
    $$(".bn-nav-group-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const group = btn.closest(".bn-nav-group");
        if (!group) return;
        const open = group.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });
  }

  function syncSidebarActive(slug) {
    $$("[data-nav-slug]").forEach((el) => {
      const active = el.getAttribute("data-nav-slug") === slug;
      el.classList.toggle("is-active", active);
      if (active) {
        const group = el.closest(".bn-nav-group");
        if (group && !group.classList.contains("is-open")) {
          group.classList.add("is-open");
          group
            .querySelector(".bn-nav-group-btn")
            ?.setAttribute("aria-expanded", "true");
        }
        el.scrollIntoView({ block: "nearest" });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Interactive Content Hydration (Code Copy, @@switch Tabs, Pipeline Explorer)
  // -------------------------------------------------------------------------
  function bindArticleInteractions(root) {
    // Copy buttons
    $$("[data-copy-code]", root).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const wrapper = btn.closest(".bn-code-wrapper");
        if (!wrapper) return;
        const activePre =
          wrapper.querySelector(".bn-tab-panel.is-active") ||
          wrapper.querySelector(".bn-code-pre");
        const text = activePre?.textContent ?? "";
        try {
          await navigator.clipboard.writeText(text);
          btn.classList.add("is-copied");
          const label = btn.querySelector(".bn-copy-label");
          if (label) label.textContent = UI.copied;
          setTimeout(() => {
            btn.classList.remove("is-copied");
            if (label) label.textContent = UI.copy;
          }, 1800);
        } catch {}
      });
    });

    // @@switch Code Tabs
    $$(".bn-code-tabs", root).forEach((group) => {
      const tabs = $$(".bn-code-tab", group);
      const panels = $$(".bn-tab-panel", group);
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          const idx = tab.getAttribute("data-tab-index");
          tabs.forEach((t) => {
            const match = t.getAttribute("data-tab-index") === idx;
            t.classList.toggle("is-active", match);
            t.setAttribute("aria-selected", match ? "true" : "false");
          });
          panels.forEach((p) => {
            const match = p.getAttribute("data-tab-panel") === idx;
            p.classList.toggle("is-active", match);
            p.hidden = !match;
          });
        });
      });
    });

    // Interactive 11-Stage Execution Pipeline Explorer
    $$(".bn-pipeline-widget", root).forEach((widget) => {
      const raw = widget.getAttribute("data-pipeline-stages");
      if (!raw) return;
      let stages = [];
      try {
        stages = JSON.parse(raw);
      } catch {
        return;
      }

      const nodes = $$("[data-pipe-idx]", widget);
      const badgeEl = $("[data-pipe-badge]", widget);
      const nameEl = $("[data-pipe-name]", widget);
      const hookEl = $("[data-pipe-hook]", widget);
      const orderEl = $("[data-pipe-order]", widget);
      const summaryEl = $("[data-pipe-summary]", widget);
      const detailEl = $("[data-pipe-detail]", widget);

      nodes.forEach((node) => {
        node.addEventListener("click", () => {
          const idx = Number(node.getAttribute("data-pipe-idx"));
          const stage = stages[idx];
          if (!stage) return;

          nodes.forEach((n) => {
            const active = Number(n.getAttribute("data-pipe-idx")) === idx;
            n.classList.toggle("is-active", active);
            n.setAttribute("aria-pressed", active ? "true" : "false");
          });

          if (badgeEl)
            badgeEl.textContent =
              stage.num === "EX" ? "EXCEPTION BOUNDARY" : `STAGE ${stage.num}`;
          if (nameEl) nameEl.textContent = stage.name;
          if (hookEl) hookEl.textContent = stage.hook;
          if (orderEl) orderEl.textContent = stage.order;
          if (summaryEl) summaryEl.textContent = stage.summary;
          if (detailEl) detailEl.textContent = stage.detail;
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Right TOC Scroll-Spy + Back to Top
  // -------------------------------------------------------------------------
  function setupTocScrollSpy() {
    if (tocObserver) {
      tocObserver.disconnect();
      tocObserver = null;
    }

    const tocLinks = $$("[data-toc-id]");
    if (tocLinks.length === 0) return;

    const headings = tocLinks
      .map((link) =>
        document.getElementById(link.getAttribute("data-toc-id") || ""),
      )
      .filter(Boolean);

    if (headings.length === 0) return;

    const setActive = (id) => {
      tocLinks.forEach((link) => {
        link.classList.toggle(
          "is-active",
          link.getAttribute("data-toc-id") === id,
        );
      });
    };

    setActive(headings[0].id);

    tocObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActive(visible[0].target.id);
        }
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );

    headings.forEach((h) => tocObserver.observe(h));
  }

  const backTopBtn = $("#bn-back-top");
  window.addEventListener(
    "scroll",
    () => {
      if (!backTopBtn) return;
      backTopBtn.hidden = window.scrollY < 320;
    },
    { passive: true },
  );
  backTopBtn?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // -------------------------------------------------------------------------
  // SPA Navigation (Instant Page Swaps with History API)
  // -------------------------------------------------------------------------
  function pathnameToSlug(pathname) {
    let stripped = pathname;
    if (
      BASE_PATH &&
      (stripped === BASE_PATH || stripped.startsWith(`${BASE_PATH}/`))
    ) {
      stripped = stripped.slice(BASE_PATH.length);
    }
    if (
      LANG_PREFIX &&
      (stripped === LANG_PREFIX || stripped.startsWith(`${LANG_PREFIX}/`))
    ) {
      stripped = stripped.slice(LANG_PREFIX.length);
    }
    const cleaned = stripped.replace(/\/+$/, "").replace(/^\/+/, "");
    if (!cleaned || cleaned === "index.html" || cleaned === "introduction")
      return "";
    return cleaned.replace(/\.html$/, "");
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderTocHtml(toc) {
    if (!toc || toc.length === 0) {
      return `<p class="bn-toc-empty">${escapeHtml(UI.noSubsections)}</p>`;
    }
    return `<ul class="bn-toc-list">${toc
      .map(
        (item) =>
          `<li class="bn-toc-item level-${item.level}"><a class="bn-toc-link" href="#${escapeHtml(item.id)}" data-toc-id="${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`,
      )
      .join("")}</ul>`;
  }

  function renderPagerHtml(prev, next) {
    const prevHtml = prev
      ? `<a class="bn-pager-card bn-pager-prev" href="${escapeHtml(prev.href)}" data-spa-link><span class="bn-pager-dir">&larr; ${escapeHtml(UI.previous)} &bull; ${escapeHtml(prev.categoryTitle)}</span><strong class="bn-pager-title">${escapeHtml(prev.title)}</strong></a>`
      : '<div class="bn-pager-spacer"></div>';
    const nextHtml = next
      ? `<a class="bn-pager-card bn-pager-next" href="${escapeHtml(next.href)}" data-spa-link><span class="bn-pager-dir">${escapeHtml(next.categoryTitle)} &bull; ${escapeHtml(UI.next)} &rarr;</span><strong class="bn-pager-title">${escapeHtml(next.title)}</strong></a>`
      : '<div class="bn-pager-spacer"></div>';
    return `<nav class="bn-pager" aria-label="${escapeHtml(UI.paginationLabel)}">${prevHtml}${nextHtml}</nav>`;
  }

  async function fetchPageData(slug) {
    if (pageCache.has(slug)) return pageCache.get(slug);
    const dataUrl = withBase(
      slug === ""
        ? `${LANG_PREFIX}/data/index.json`
        : `${LANG_PREFIX}/data/${slug}.json`,
    );
    const res = await fetch(dataUrl);
    if (!res.ok) return null;
    const json = await res.json();
    pageCache.set(slug, json);
    return json;
  }

  function syncLangSwitcher(slug) {
    const enHref = hrefForLang(slug, "en");
    const viHref = hrefForLang(slug, "vi");
    $$('[data-lang-switch="en"]').forEach((el) =>
      el.setAttribute("href", enHref),
    );
    $$('[data-lang-switch="vi"]').forEach((el) =>
      el.setAttribute("href", viHref),
    );
  }

  async function navigateTo(href, pushHistory = true) {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) {
      window.location.href = href;
      return;
    }

    const targetSlug = pathnameToSlug(url.pathname);
    const currentSlug = document.body.getAttribute("data-current-slug") || "";

    closeSidebar();

    if (targetSlug === currentSlug) {
      if (url.hash) {
        const el = document.getElementById(url.hash.slice(1));
        if (el) el.scrollIntoView({ behavior: "smooth" });
        if (pushHistory) history.pushState({}, "", url.pathname + url.hash);
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }

    const page = await fetchPageData(targetSlug);
    if (!page) {
      window.location.href = href;
      return;
    }

    const contentEl = $("#bn-content");
    const kickerEl = $("#bn-page-kicker");
    const readEl = $("#bn-reading-time");
    const badgeSlot = $("#bn-meta-badge-slot");
    const tocSlot = $("#bn-toc-slot");
    const pagerSlot = $("#bn-pager-slot");

    if (contentEl) contentEl.innerHTML = page.html;
    if (kickerEl) kickerEl.textContent = page.categoryTitle;
    if (readEl) readEl.textContent = `${page.readingMinutes} ${UI.minRead}`;
    if (badgeSlot) {
      badgeSlot.innerHTML = page.badge
        ? `<span class="bn-meta-badge">${escapeHtml(page.badge)}</span>`
        : "";
    }
    if (tocSlot) tocSlot.innerHTML = renderTocHtml(page.toc);
    if (pagerSlot) pagerSlot.innerHTML = renderPagerHtml(page.prev, page.next);

    const editLink = $("#bn-edit-github");
    if (editLink && page.sourceFile) {
      const currentHref = editLink.getAttribute("href") || "";
      const baseRepo = currentHref.split("/edit/main/")[0] || "https://github.com/nctuanit/bunest";
      editLink.setAttribute("href", `${baseRepo}/edit/main/${page.sourceFile}`);
    }

    document.body.setAttribute("data-current-slug", page.slug);
    document.title =
      page.slug === ""
        ? UI.siteTitle
        : `${page.title} | ${UI.titleSuffix}`;

    if (pushHistory) {
      history.pushState({ slug: page.slug }, "", url.pathname + url.hash);
    }

    syncSidebarActive(page.slug);
    syncLangSwitcher(page.slug);
    if (contentEl) bindArticleInteractions(contentEl);
    setupTocScrollSpy();

    if (url.hash) {
      const el = document.getElementById(url.hash.slice(1));
      if (el) el.scrollIntoView();
      else window.scrollTo({ top: 0 });
    } else {
      window.scrollTo({ top: 0 });
    }
  }

  document.addEventListener("click", (ev) => {
    if (
      ev.defaultPrevented ||
      ev.button !== 0 ||
      ev.metaKey ||
      ev.ctrlKey ||
      ev.shiftKey ||
      ev.altKey
    ) {
      return;
    }
    const anchor =
      ev.target instanceof Element
        ? ev.target.closest("a[data-spa-link]")
        : null;
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    ev.preventDefault();
    navigateTo(href, true);
  });

  window.addEventListener("popstate", () => {
    navigateTo(window.location.pathname + window.location.hash, false);
  });

  // -------------------------------------------------------------------------
  // Instant Command Palette Search (Cmd+K / Ctrl+K / "/")
  // -------------------------------------------------------------------------
  const searchModal = $("#bn-search-modal");
  const searchInput = $("#bn-search-input");
  const searchResults = $("#bn-search-results");

  async function ensureSearchIndex() {
    if (searchIndex) return searchIndex;
    try {
      const res = await fetch(withBase(`${LANG_PREFIX}/data/search-index.json`));
      searchIndex = await res.json();
    } catch {
      searchIndex = [];
    }
    return searchIndex;
  }

  function highlightMatch(text, terms) {
    let safe = escapeHtml(text);
    for (const term of terms) {
      if (term.length < 2) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      safe = safe.replace(new RegExp(`(${escaped})`, "gi"), "<mark>$1</mark>");
    }
    return safe;
  }

  function runSearch(query) {
    if (!searchResults) return;
    const q = query.trim().toLowerCase();

    if (!q) {
      const suggested = [
        {
          title: "First steps",
          categoryTitle: "OVERVIEW",
          href: withBase(`${LANG_PREFIX}/overview/first-steps`),
          headingText: "Setup tsconfig.json & BunestFactory",
          snippet:
            "Install Bunest, configure legacy decorators, and boot your first app.",
        },
        {
          title: "Controllers",
          categoryTitle: "OVERVIEW",
          href: withBase(`${LANG_PREFIX}/overview/controllers`),
          headingText: "@Controller, @Get, @Post & parameter decorators",
          snippet:
            "Compile-at-bootstrap routing with @Body, @Param, @Query, @Res.",
        },
        {
          title: "Validation",
          categoryTitle: "TECHNIQUES",
          href: withBase(`${LANG_PREFIX}/techniques/validation`),
          headingText: "ValidationPipe & SchemaValidationPipe",
          snippet:
            "Secure defaults (whitelist, forbidNonWhitelisted), Zod adapter, HTTP 400 format.",
        },
        {
          title: "11-Stage Execution Pipeline",
          categoryTitle: "ARCHITECTURE & ADRs",
          href: withBase(`${LANG_PREFIX}/architecture/execution-pipeline`),
          headingText: "Interactive ADR-008 Pipeline Explorer",
          snippet:
            "Exact order: CORS -> Middleware -> Guards -> Interceptors -> Pipes -> Handler.",
        },
        {
          title: "Injection scopes",
          categoryTitle: "FUNDAMENTALS",
          href: withBase(`${LANG_PREFIX}/fundamentals/injection-scopes`),
          headingText: "Scope.REQUEST & ScopeLeakException",
          snippet:
            "AsyncLocalStorage propagation with fail-fast bootstrap scope-leak detection.",
        },
        {
          title: "Hybrid Bun.serve Router",
          categoryTitle: "ARCHITECTURE & ADRs",
          href: withBase(`${LANG_PREFIX}/architecture/hybrid-router`),
          headingText: "Native Zig routes + Fallback Radix Router",
          snippet:
            "Verified Bun 1.4.5+ routes matrix, O(1) 405 + Allow, and CORS preflight.",
        },
      ];
      currentSearchMatches = suggested;
      searchSelectedIndex = 0;
      renderSearchResults(suggested, [], "SUGGESTED PAGES");
      return;
    }

    const terms = q.split(/\s+/).filter(Boolean);
    const scored = [];

    for (const doc of searchIndex || []) {
      const titleL = doc.title.toLowerCase();
      const headingL = doc.headingText.toLowerCase();
      const keywordsL = doc.keywords.toLowerCase();
      const snippetL = doc.snippet.toLowerCase();
      const combined = `${titleL} ${headingL} ${keywordsL} ${snippetL}`;

      let allMatch = true;
      let score = 0;

      for (const t of terms) {
        if (!combined.includes(t)) {
          allMatch = false;
          break;
        }
        if (titleL === t) score += 120;
        else if (titleL.includes(t)) score += 65;
        if (headingL.includes(t)) score += 45;
        if (keywordsL.includes(t)) score += 30;
        if (snippetL.includes(t)) score += 12;
        if (!doc.headingId) score += 10; // slight preference for page top
      }

      if (allMatch) {
        scored.push({ doc, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 12).map((s) => s.doc);
    currentSearchMatches = top;
    searchSelectedIndex = 0;
    renderSearchResults(top, terms, `RESULTS (${top.length})`);
  }

  function renderSearchResults(items, terms, label) {
    if (!searchResults) return;
    if (items.length === 0) {
      searchResults.innerHTML = `<div class="bn-search-empty">No results found. Try searching for <code>@Controller</code>, <code>ValidationPipe</code>, <code>Scope.REQUEST</code>, or <code>ADR-008</code>.</div>`;
      return;
    }

    const rows = items
      .map((item, idx) => {
        const headingPart =
          item.headingText && item.headingText !== item.title
            ? ` &rsaquo; ${highlightMatch(item.headingText, terms)}`
            : "";
        return `<a class="bn-search-item${idx === searchSelectedIndex ? " is-selected" : ""}" href="${escapeHtml(item.href)}" data-search-idx="${idx}" role="option" aria-selected="${idx === searchSelectedIndex ? "true" : "false"}">
          <div class="bn-search-item-top">
            <span class="bn-search-item-cat">${escapeHtml(item.categoryTitle)}</span>
            <span>${highlightMatch(item.title, terms)}${headingPart}</span>
          </div>
          <div class="bn-search-item-snippet">${highlightMatch(item.snippet, terms)}</div>
        </a>`;
      })
      .join("");

    searchResults.innerHTML = `<div class="bn-search-group-label">${escapeHtml(label)}</div>${rows}`;
  }

  function updateSearchSelection(newIdx) {
    if (currentSearchMatches.length === 0) return;
    searchSelectedIndex =
      (newIdx + currentSearchMatches.length) % currentSearchMatches.length;
    $$("[data-search-idx]", searchResults).forEach((el) => {
      const active =
        Number(el.getAttribute("data-search-idx")) === searchSelectedIndex;
      el.classList.toggle("is-selected", active);
      el.setAttribute("aria-selected", active ? "true" : "false");
      if (active) el.scrollIntoView({ block: "nearest" });
    });
  }

  const searchTrigger = $("#bn-search-trigger");

  async function openSearch() {
    if (!searchModal) return;
    if (sidebar?.classList.contains("is-open")) {
      closeSidebar(false);
    }
    searchLastFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : searchTrigger;
    searchModal.hidden = false;
    syncScrollLock();
    await ensureSearchIndex();
    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
    }
    runSearch("");
  }

  function closeSearch(restoreFocus = false) {
    if (!searchModal) return;
    const wasOpen = !searchModal.hidden;
    searchModal.hidden = true;
    syncScrollLock();
    if (restoreFocus && wasOpen) {
      const target =
        searchLastFocused instanceof HTMLElement
          ? searchLastFocused
          : searchTrigger;
      searchLastFocused = null;
      target?.focus();
    } else if (!wasOpen) {
      searchLastFocused = null;
    }
  }

  searchTrigger?.addEventListener("click", openSearch);
  $$("[data-close-search]").forEach((el) =>
    el.addEventListener("click", () => closeSearch(true)),
  );

  searchInput?.addEventListener("input", (e) => {
    runSearch(e.target.value);
  });

  searchResults?.addEventListener("click", (e) => {
    const item =
      e.target instanceof Element
        ? e.target.closest("[data-search-idx]")
        : null;
    if (!item) return;
    e.preventDefault();
    const href = item.getAttribute("href");
    closeSearch();
    if (href) navigateTo(href, true);
  });

  document.addEventListener("keydown", (e) => {
    // Cmd+K or Ctrl+K
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (searchModal?.hidden) openSearch();
      else closeSearch();
      return;
    }

    // "/" shortcut when not typing in an input
    if (
      e.key === "/" &&
      searchModal?.hidden &&
      !(document.activeElement instanceof HTMLInputElement) &&
      !(document.activeElement instanceof HTMLTextAreaElement)
    ) {
      e.preventDefault();
      openSearch();
      return;
    }

    if (e.key === "Escape") {
      if (searchModal && !searchModal.hidden) {
        e.preventDefault();
        closeSearch(true);
      } else if (sidebar?.classList.contains("is-open")) {
        e.preventDefault();
        closeSidebar(true);
      }
      return;
    }

    if (searchModal && !searchModal.hidden) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        updateSearchSelection(searchSelectedIndex + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        updateSearchSelection(searchSelectedIndex - 1);
      } else if (e.key === "Enter") {
        const picked = currentSearchMatches[searchSelectedIndex];
        if (picked) {
          e.preventDefault();
          closeSearch();
          navigateTo(picked.href, true);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // Initial Boot
  // -------------------------------------------------------------------------
  initSidebarAccordions();
  const initialContent = $("#bn-content");
  if (initialContent) bindArticleInteractions(initialContent);
  setupTocScrollSpy();
})();
