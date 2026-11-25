import { renderComponent } from "./components";
import type { DocsLang } from "./i18n";
import { withBasePath } from "./navigation";

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface SearchSection {
  headingId: string;
  headingText: string;
  content: string;
}

export interface RenderedMarkdown {
  html: string;
  toc: TocItem[];
  sections: SearchSection[];
  readingMinutes: number;
}

function escapeHtml(str: string): string {
  return Bun.escapeHTML(str);
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function stripMarkdownToPlainText(md: string): string {
  return md
    .replace(/@@component\([^)]*\)/g, " ")
    .replace(/@@filename\([^)]*\)/g, " ")
    .replace(/@@tab\([^)]*\)/g, " ")
    .replace(/@@switch/g, " ")
    .replace(/```[\s\S]*?```/g, (block) =>
      block
        .replace(/^```[^\n]*\n?/, "")
        .replace(/```$/, "")
        .replace(/\s+/g, " "),
    )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s*(info|warning|tip|danger)?\s*/gim, "")
    .replace(/[*_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Syntax Highlighter (TypeScript / JavaScript / JSON / Bash / Text)
// ---------------------------------------------------------------------------

const TS_KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "as",
  "type",
  "interface",
  "class",
  "extends",
  "implements",
  "abstract",
  "constructor",
  "public",
  "private",
  "protected",
  "readonly",
  "static",
  "override",
  "async",
  "await",
  "function",
  "return",
  "const",
  "let",
  "var",
  "new",
  "if",
  "else",
  "for",
  "of",
  "in",
  "while",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "keyof",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "this",
  "super",
  "enum",
  "declare",
  "satisfies",
  "yield",
]);

const TS_BUILTINS = new Set([
  "Promise",
  "Response",
  "Request",
  "Headers",
  "URL",
  "Blob",
  "ReadableStream",
  "AsyncIterable",
  "AsyncGenerator",
  "Uint8Array",
  "ArrayBuffer",
  "Record",
  "Array",
  "Map",
  "Set",
  "Date",
  "Error",
  "Symbol",
  "Number",
  "String",
  "Boolean",
  "Object",
  "Function",
  "Bun",
  "BunFile",
  "console",
  "JSON",
  "process",
  "unknown",
  "never",
  "any",
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
]);

function highlightTypeScript(code: string): string {
  let out = "";
  let i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code[i]!;
    const next = code[i + 1];

    // Single-line comment
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      out += `<span class="tok-comment">${escapeHtml(slice)}</span>`;
      i += slice.length;
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      out += `<span class="tok-comment">${escapeHtml(slice)}</span>`;
      i += slice.length;
      continue;
    }

    // Strings & template literals
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += `<span class="tok-string">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Decorators: @Controller, @Get, @Body, etc.
    if (ch === "@" && next && /[A-Za-z_$]/.test(next)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$.]/.test(code[j]!)) {
        j += 1;
      }
      out += `<span class="tok-decorator">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(code[i - 1]!))) {
      let j = i;
      while (j < len && /[0-9a-fA-FxXoObB._]/.test(code[j]!)) {
        j += 1;
      }
      out += `<span class="tok-number">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Identifiers, keywords, types, functions
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$]/.test(code[j]!)) {
        j += 1;
      }
      const word = code.slice(i, j);
      const after = code[j];

      if (TS_KEYWORDS.has(word)) {
        out += `<span class="tok-keyword">${escapeHtml(word)}</span>`;
      } else if (TS_BUILTINS.has(word)) {
        out += `<span class="tok-type">${escapeHtml(word)}</span>`;
      } else if (after === "(") {
        out += `<span class="tok-fn">${escapeHtml(word)}</span>`;
      } else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) {
        out += `<span class="tok-class">${escapeHtml(word)}</span>`;
      } else {
        out += escapeHtml(word);
      }
      i = j;
      continue;
    }

    // Punctuation / operators
    if ("{}[]()<>:;,.=+-*/!&|?".includes(ch)) {
      out += `<span class="tok-punct">${escapeHtml(ch)}</span>`;
      i += 1;
      continue;
    }

    out += escapeHtml(ch);
    i += 1;
  }

  return out;
}

function highlightJson(code: string): string {
  let out = "";
  let i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code[i]!;

    // Allow comments in tsconfig JSON snippets
    if (ch === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      out += `<span class="tok-comment">${escapeHtml(slice)}</span>`;
      i += slice.length;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < len) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      const raw = code.slice(i, j);
      let k = j;
      while (k < len && (code[k] === " " || code[k] === "\t")) k++;
      const isKey = code[k] === ":";
      out += `<span class="${isKey ? "tok-prop" : "tok-string"}">${escapeHtml(raw)}</span>`;
      i = j;
      continue;
    }

    if (/[0-9-]/.test(ch) && (ch !== "-" || /[0-9]/.test(code[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < len && /[0-9.eE+-]/.test(code[j]!)) j++;
      out += `<span class="tok-number">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    if (/[a-z]/.test(ch)) {
      let j = i;
      while (j < len && /[a-z]/.test(code[j]!)) j++;
      const word = code.slice(i, j);
      if (word === "true" || word === "false" || word === "null") {
        out += `<span class="tok-keyword">${word}</span>`;
      } else {
        out += escapeHtml(word);
      }
      i = j;
      continue;
    }

    out += escapeHtml(ch);
    i += 1;
  }

  return out;
}

function highlightBash(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#")) {
        return `<span class="tok-comment">${escapeHtml(line)}</span>`;
      }
      return line
        .replace(
          /^(\s*)(\$\s+)?(bun|bunx|curl|git|mkdir|cd|export|NODE_ENV=[^\s]+)(?=\s|$)/,
          (_, indent: string, prompt: string | undefined, cmd: string) =>
            `${escapeHtml(indent)}${prompt ? `<span class="tok-punct">${escapeHtml(prompt)}</span>` : ""}<span class="tok-fn">${escapeHtml(cmd)}</span>`,
        )
        .replace(
          /(\s)(--?[a-zA-Z0-9_-]+)/g,
          (_, sp: string, flag: string) =>
            `${sp}<span class="tok-decorator">${escapeHtml(flag)}</span>`,
        );
    })
    .join("\n");
}

function highlightCode(code: string, lang: string): string {
  const normalized = lang.trim().toLowerCase();
  if (
    normalized === "ts" ||
    normalized === "tsx" ||
    normalized === "typescript" ||
    normalized === "js" ||
    normalized === "jsx" ||
    normalized === "javascript"
  ) {
    return highlightTypeScript(code);
  }
  if (normalized === "json" || normalized === "jsonc") {
    return highlightJson(code);
  }
  if (normalized === "bash" || normalized === "sh" || normalized === "shell") {
    return highlightBash(code);
  }
  return escapeHtml(code);
}

// ---------------------------------------------------------------------------
// Inline Markdown Formatting
// ---------------------------------------------------------------------------

function renderInline(text: string, basePath = ""): string {
  const codePlaceholders: string[] = [];

  // Preserve inline code spans first so inner chars are untouched
  let work = text.replace(/`([^`]+)`/g, (_, code: string) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  work = escapeHtml(work);

  // Links: [label](href)
  work = work.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, href: string) => {
      const isExternal = /^https?:\/\//i.test(href);
      if (isExternal) {
        return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}<svg class="bn-ext-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;
      }
      const resolvedHref = href.startsWith("/")
        ? withBasePath(href, basePath)
        : href;
      return `<a href="${resolvedHref}" data-spa-link>${label}</a>`;
    },
  );

  // Bold + Italic, Bold, Italic, Strikethrough
  work = work.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  work = work.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  work = work.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  work = work.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // Restore inline code spans
  work = work.replace(/\u0000CODE(\d+)\u0000/g, (_, idxStr: string) => {
    const idx = Number(idxStr);
    return codePlaceholders[idx] ?? "";
  });

  return work;
}

// ---------------------------------------------------------------------------
// Block Renderer Helpers
// ---------------------------------------------------------------------------

interface CodeBlockTab {
  label: string;
  lang: string;
  filename?: string;
  code: string;
}

function defaultTabLabel(lang: string, index: number): string {
  const l = lang.toLowerCase();
  if (l === "ts" || l === "typescript") return "TypeScript";
  if (l === "js" || l === "javascript") return "JavaScript";
  if (l === "bash" || l === "sh" || l === "shell") return "Terminal";
  if (l === "json" || l === "jsonc") return "JSON";
  return lang ? lang.toUpperCase() : `Tab ${index + 1}`;
}

function renderCodeBlockGroup(tabs: CodeBlockTab[], groupId: number): string {
  const first = tabs[0]!;
  const isSwitch = tabs.length > 1;
  const headerFile = first.filename;

  const copyBtn = `<button type="button" class="bn-copy-btn" data-copy-code aria-label="Copy code">
    <svg class="bn-icon-copy" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    <svg class="bn-icon-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    <span class="bn-copy-label">Copy</span>
  </button>`;

  if (!isSwitch) {
    const langLabel = first.lang ? first.lang.toUpperCase() : "CODE";
    const highlighted = highlightCode(first.code, first.lang);
    return `<div class="bn-code-wrapper" data-code-group="${groupId}">
  <div class="bn-code-header">
    <div class="bn-code-header-left">
      ${headerFile ? `<span class="bn-code-filename"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${escapeHtml(headerFile)}</span>` : `<span class="bn-code-lang-pill">${escapeHtml(langLabel)}</span>`}
    </div>
    <div class="bn-code-header-right">
      ${headerFile ? `<span class="bn-code-lang-subtle">${escapeHtml(langLabel)}</span>` : ""}
      ${copyBtn}
    </div>
  </div>
  <pre class="bn-code-pre"><code class="language-${escapeHtml(first.lang || "text")}">${highlighted}</code></pre>
</div>`;
  }

  const tabButtons = tabs
    .map(
      (tab, idx) =>
        `<button type="button" class="bn-code-tab${idx === 0 ? " is-active" : ""}" data-tab-index="${idx}" role="tab" aria-selected="${idx === 0 ? "true" : "false"}">${escapeHtml(tab.label)}</button>`,
    )
    .join("");

  const tabPanels = tabs
    .map((tab, idx) => {
      const highlighted = highlightCode(tab.code, tab.lang);
      return `<pre class="bn-code-pre bn-tab-panel${idx === 0 ? " is-active" : ""}" data-tab-panel="${idx}"${idx === 0 ? "" : " hidden"}><code class="language-${escapeHtml(tab.lang || "text")}">${highlighted}</code></pre>`;
    })
    .join("");

  return `<div class="bn-code-wrapper bn-code-tabs" data-code-group="${groupId}">
  <div class="bn-code-header">
    <div class="bn-code-header-left">
      ${headerFile ? `<span class="bn-code-filename">${escapeHtml(headerFile)}</span>` : ""}
      <div class="bn-tab-bar" role="tablist">${tabButtons}</div>
    </div>
    <div class="bn-code-header-right">
      ${copyBtn}
    </div>
  </div>
  ${tabPanels}
</div>`;
}

function renderCallout(
  kind: string,
  bodyLines: string[],
  basePath = "",
): string {
  const normalized = kind.toLowerCase();
  const icons: Record<string, string> = {
    info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    tip: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>`,
    warning: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    danger: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  const icon = icons[normalized] ?? icons.info!;
  const contentHtml = bodyLines
    .join("\n")
    .split(/\n\s*\n/)
    .map(
      (p) => `<p>${renderInline(p.replace(/\n/g, " ").trim(), basePath)}</p>`,
    )
    .join("");

  return `<blockquote class="bn-callout bn-callout-${normalized}">
  <div class="bn-callout-icon" aria-hidden="true">${icon}</div>
  <div class="bn-callout-body">${contentHtml}</div>
</blockquote>`;
}

function splitTableRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let inCode = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  return /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(trimmed);
}

// ---------------------------------------------------------------------------
// Main Markdown Parser
// ---------------------------------------------------------------------------

export function renderMarkdown(
  rawMarkdown: string,
  options: { basePath?: string; lang?: DocsLang } = {},
): RenderedMarkdown {
  const basePath = options.basePath ?? "";
  const lang: DocsLang = options.lang ?? "en";
  const normalized = rawMarkdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const toc: TocItem[] = [];
  const usedHeadingIds = new Map<string, number>();
  const sections: SearchSection[] = [];
  let currentSection: SearchSection = {
    headingId: "",
    headingText: "",
    content: "",
  };
  let codeGroupCounter = 0;

  const htmlParts: string[] = [];
  let i = 0;

  const flushSection = () => {
    if (
      currentSection.content.trim().length > 0 ||
      currentSection.headingText
    ) {
      sections.push({
        headingId: currentSection.headingId,
        headingText: currentSection.headingText,
        content: stripMarkdownToPlainText(currentSection.content),
      });
    }
  };

  const uniqueHeadingId = (text: string): string => {
    const base = slugifyHeading(text) || "section";
    const count = usedHeadingIds.get(base) ?? 0;
    usedHeadingIds.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "") {
      i += 1;
      continue;
    }

    // Custom embedded visual component: @@component(name)
    const compMatch = trimmed.match(/^@@component\((.+)\)$/);
    if (compMatch) {
      htmlParts.push(renderComponent(compMatch[1]!, basePath, lang));
      i += 1;
      continue;
    }

    // Headings: # through ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const rawText = headingMatch[2]!.trim();
      const plainText = rawText.replace(/`([^`]+)`/g, "$1");

      if (level === 1) {
        // H1 rendered in page header or body; keep id
        const id = uniqueHeadingId(plainText);
        flushSection();
        currentSection = { headingId: id, headingText: plainText, content: "" };
        htmlParts.push(
          `<h1 id="${id}" class="bn-doc-h1">${renderInline(rawText, basePath)}</h1>`,
        );
      } else if (level === 2 || level === 3) {
        const id = uniqueHeadingId(plainText);
        toc.push({ id, text: plainText, level });
        flushSection();
        currentSection = { headingId: id, headingText: plainText, content: "" };
        htmlParts.push(
          `<h${level} id="${id}" class="bn-heading"><a class="bn-anchor" href="#${id}" aria-label="Link to ${escapeHtml(plainText)}">#</a>${renderInline(rawText, basePath)}</h${level}>`,
        );
      } else {
        const id = uniqueHeadingId(plainText);
        htmlParts.push(
          `<h4 id="${id}">${renderInline(rawText, basePath)}</h4>`,
        );
      }
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      htmlParts.push("<hr />");
      i += 1;
      continue;
    }

    // NestJS-style Code Block (with optional @@filename(...) and @@tab(...) / @@switch)
    const filenameMatch = trimmed.match(/^@@filename\((.+)\)$/);
    const tabMatch = trimmed.match(/^@@tab\((.+)\)$/);
    if (filenameMatch || tabMatch || trimmed.startsWith("```")) {
      let pendingFilename = filenameMatch
        ? filenameMatch[1]!.trim()
        : undefined;
      let pendingTabLabel = tabMatch ? tabMatch[1]!.trim() : undefined;
      if (filenameMatch || tabMatch) {
        i += 1;
        // Allow optional second directive (e.g. @@filename followed by @@tab)
        while (i < lines.length) {
          const t = lines[i]!.trim();
          const fm = t.match(/^@@filename\((.+)\)$/);
          const tm = t.match(/^@@tab\((.+)\)$/);
          if (fm) {
            pendingFilename = fm[1]!.trim();
            i += 1;
          } else if (tm) {
            pendingTabLabel = tm[1]!.trim();
            i += 1;
          } else if (t === "") {
            i += 1;
          } else {
            break;
          }
        }
      }

      const tabs: CodeBlockTab[] = [];
      let tabIdx = 0;

      while (i < lines.length && lines[i]!.trim().startsWith("```")) {
        const openFence = lines[i]!.trim();
        const lang = openFence.slice(3).trim();
        i += 1;
        const codeLines: string[] = [];
        while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
          codeLines.push(lines[i]!);
          i += 1;
        }
        if (i < lines.length && lines[i]!.trim().startsWith("```")) {
          i += 1;
        }

        const codeStr = codeLines.join("\n");
        currentSection.content += " " + codeStr;

        tabs.push({
          label: pendingTabLabel ?? defaultTabLabel(lang, tabIdx),
          lang,
          filename: pendingFilename,
          code: codeStr,
        });
        tabIdx += 1;
        pendingTabLabel = undefined;

        // Check if followed by @@switch
        let lookahead = i;
        while (lookahead < lines.length && lines[lookahead]!.trim() === "") {
          lookahead += 1;
        }
        if (lines[lookahead]?.trim() === "@@switch") {
          i = lookahead + 1;
          while (i < lines.length) {
            const nextT = lines[i]!.trim();
            const nextTab = nextT.match(/^@@tab\((.+)\)$/);
            if (nextTab) {
              pendingTabLabel = nextTab[1]!.trim();
              i += 1;
            } else if (nextT === "") {
              i += 1;
            } else {
              break;
            }
          }
          continue;
        }
        break;
      }

      if (tabs.length > 0) {
        codeGroupCounter += 1;
        htmlParts.push(renderCodeBlockGroup(tabs, codeGroupCounter));
      }
      continue;
    }

    // Blockquotes & NestJS Callouts (> info / > warning / > tip / > danger)
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const firstLine = quoteLines[0] ?? "";
      const calloutMatch = firstLine.match(
        /^(info|warning|tip|danger)\s+(.*)$/i,
      );
      if (calloutMatch) {
        const kind = calloutMatch[1]!.toLowerCase();
        const bodyLines = [calloutMatch[2]!, ...quoteLines.slice(1)];
        currentSection.content += " " + bodyLines.join(" ");
        htmlParts.push(renderCallout(kind, bodyLines, basePath));
      } else {
        currentSection.content += " " + quoteLines.join(" ");
        const inner = quoteLines
          .join("\n")
          .split(/\n\s*\n/)
          .map(
            (p) =>
              `<p>${renderInline(p.replace(/\n/g, " ").trim(), basePath)}</p>`,
          )
          .join("");
        htmlParts.push(`<blockquote class="bn-quote">${inner}</blockquote>`);
      }
      continue;
    }

    // GFM Tables
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1]!)
    ) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i]!.trim() !== "" &&
        lines[i]!.includes("|")
      ) {
        rows.push(splitTableRow(lines[i]!));
        i += 1;
      }

      currentSection.content +=
        " " + headers.join(" ") + " " + rows.map((r) => r.join(" ")).join(" ");

      const thead = `<thead><tr>${headers.map((h) => `<th>${renderInline(h, basePath)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map(
          (row) =>
            `<tr>${headers
              .map(
                (_, idx) =>
                  `<td>${renderInline(row[idx] ?? "", basePath)}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("")}</tbody>`;
      htmlParts.push(
        `<div class="bn-table-wrap"><table>${thead}${tbody}</table></div>`,
      );
      continue;
    }

    // Unordered or Ordered Lists (with task list checkbox support)
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      const isOrdered = Boolean(olMatch);
      const tag = isOrdered ? "ol" : "ul";
      const items: string[] = [];

      while (i < lines.length) {
        const cur = lines[i]!;
        const match = isOrdered
          ? cur.match(/^(\s*)\d+\.\s+(.+)$/)
          : cur.match(/^(\s*)[-*+]\s+(.+)$/);
        if (!match) break;

        let itemText = match[2]!.trim();
        i += 1;

        // Collect continuation indented lines
        while (
          i < lines.length &&
          lines[i]!.trim() !== "" &&
          /^\s{2,}/.test(lines[i]!) &&
          !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)
        ) {
          itemText += " " + lines[i]!.trim();
          i += 1;
        }

        currentSection.content += " " + itemText;

        const taskMatch = itemText.match(/^\[(x|X| )\]\s+(.+)$/);
        if (taskMatch) {
          const checked = taskMatch[1]!.toLowerCase() === "x";
          items.push(
            `<li class="bn-task-item"><span class="bn-checkbox${checked ? " is-checked" : ""}" aria-hidden="true">${checked ? "✓" : ""}</span><span>${renderInline(taskMatch[2]!, basePath)}</span></li>`,
          );
        } else {
          items.push(`<li>${renderInline(itemText, basePath)}</li>`);
        }
      }

      htmlParts.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // Standard Paragraph
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      const curTrim = cur.trim();
      if (
        curTrim === "" ||
        curTrim.startsWith("#") ||
        curTrim.startsWith("```") ||
        curTrim.startsWith(">") ||
        curTrim.startsWith("@@") ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(curTrim) ||
        /^(\s*)([-*+]|\d+\.)\s+/.test(cur) ||
        (cur.includes("|") &&
          i + 1 < lines.length &&
          isTableSeparator(lines[i + 1]!))
      ) {
        break;
      }
      paraLines.push(curTrim);
      i += 1;
    }

    if (paraLines.length === 0) {
      paraLines.push(trimmed);
      i += 1;
    }

    const joined = paraLines.join(" ");
    currentSection.content += " " + joined;
    htmlParts.push(`<p>${renderInline(joined, basePath)}</p>`);
  }

  flushSection();

  const wordCount = stripMarkdownToPlainText(normalized)
    .split(/\s+/)
    .filter(Boolean).length;
  const readingMinutes = Math.max(1, Math.round(wordCount / 220));

  return {
    html: htmlParts.join("\n"),
    toc,
    sections,
    readingMinutes,
  };
}
