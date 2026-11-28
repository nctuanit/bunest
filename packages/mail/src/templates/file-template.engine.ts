import {
  findEmbeddedFile,
  isStandaloneExecutable,
  join,
  resolve,
  sep,
} from "@bunest/core";
import { MailTemplateError } from "../errors/mail-template.error";
import type {
  FileTemplateEngineOptions,
  MailTemplateRenderOptions,
} from "../interfaces/mail-template.interface";
import { unsafeHtml } from "../message/html.util";
import { MailTemplateEngine } from "./mail-template.engine";
import {
  compileTemplate,
  renderTemplate,
  TEMPLATE_NAME,
  type CompiledTemplate,
  type TemplateKind,
} from "./template-compiler.util";

/** A language tag such as `pl`, `pt-BR` or `zh-Hant-TW`: it becomes part of a file name. */
const LOCALE = /^[A-Za-z0-9]{1,8}(?:[-_][A-Za-z0-9]{1,8})*$/;
/** RFC 5646 asks a length limit to allow 35 characters; a longer locale would make long file names and many lookups. */
const MAX_LOCALE_LENGTH = 35;
const EXTENSIONS: Record<TemplateKind, string> = {
  html: ".html",
  text: ".txt",
};

/**
 * Renders mail from a directory of template files, with no dependencies:
 *
 * ```ts
 * MailModule.forRoot({
 *   transport,
 *   templates: new FileTemplateEngine({ dir: join(import.meta.dirname, 'mail/templates'), layout: 'layout' }),
 * });
 * ```
 *
 * `template: 'order-confirmation'` with the locale `pl` renders `order-confirmation.pl.html`,
 * else `order-confirmation.html`, and `order-confirmation.pl.txt` or
 * `order-confirmation.txt` as the text part when one exists. `{{> footer}}` includes
 * `partials/footer.html` (or `.txt`), looked up the same way.
 *
 * The syntax is a subset of Handlebars, so the templates move to Handlebars unchanged:
 * `{{ path.to.value }}` (HTML-escaped), `{{{ raw }}}`, `{{#if}}`, `{{#unless}}` and
 * `{{#each}}` with `{{else}}`, `this`, `@index`, `@first`, `@last`, `@key`, `@root`,
 * `../`, `{{> partial}}` and `{{! comments }}`. No helpers: the mail class prepares the
 * values. Escaping protects element content and quoted attribute values, so a `{{ }}`
 * anywhere else in a tag is a compile error, as with the `html` tag.
 */
export class FileTemplateEngine extends MailTemplateEngine {
  private readonly dir: string;
  private readonly layout: string | undefined;
  private readonly cache: boolean;
  private readonly embeddedFiles: readonly Blob[] | undefined;
  /** By path relative to `dir`: the compiled file, or `undefined` when there is no such file. */
  private readonly files = new Map<
    string,
    Promise<CompiledTemplate | undefined>
  >();

  constructor(options: FileTemplateEngineOptions) {
    super();
    if (!options || typeof options.dir !== "string" || !options.dir) {
      throw new TypeError(
        "FileTemplateEngine needs `dir`, the directory of the templates",
      );
    }
    if (
      options.layout !== undefined &&
      (typeof options.layout !== "string" ||
        !TEMPLATE_NAME.test(options.layout))
    ) {
      throw new TypeError(
        `FileTemplateEngine: \`layout\` must be a template name, such as "layout" (got ${String(options.layout)})`,
      );
    }
    if (options.cache !== undefined && typeof options.cache !== "boolean") {
      throw new TypeError("FileTemplateEngine: `cache` must be a boolean");
    }
    this.dir = resolve(options.dir);
    this.layout = options.layout;
    this.cache = options.cache ?? true;
    this.embeddedFiles = options.embeddedFiles;
  }

  override async render(
    name: string,
    context: object,
    { locale }: MailTemplateRenderOptions,
  ): Promise<{ html: string; text?: string }> {
    if (typeof name !== "string" || !TEMPLATE_NAME.test(name)) {
      throw new MailTemplateError(
        `Invalid template name "${String(name)}": use letters, digits, "-" and "_", with "/" between folders, ` +
          "and no extension",
        { template: String(name) },
      );
    }
    if (
      locale !== undefined &&
      (typeof locale !== "string" ||
        locale.length > MAX_LOCALE_LENGTH ||
        !LOCALE.test(locale))
    ) {
      throw new MailTemplateError(
        `Invalid locale "${String(locale)}" for the template "${name}"`,
        { template: name },
      );
    }
    const html = await this.find(name, "html", locale);
    const text = await this.find(name, "text", locale);

    if (!html) {
      const md = await this.findMarkdown(name, locale);
      if (!md) {
        const lookedFor = [
          ...this.candidates(name, "html", locale),
          ...this.markdownCandidates(name, locale),
        ];
        throw new MailTemplateError(
          `No template "${name}" in ${this.dir} (looked for ${lookedFor.join(", ")})`,
          { template: name },
        );
      }
      const mdPartials = await this.partials(md, locale);
      // Escape interpolated values for the HTML render to prevent XSS while
      // preserving template Markdown syntax and explicit `{{{ raw }}}` / `unsafeHtml()`.
      const escapedMd = renderTemplate(md, context, mdPartials, {
        escapeHtmlValues: true,
      });
      const mdHtml = (
        Bun as unknown as { markdown: { html(input: string): string } }
      ).markdown.html(escapedMd);
      const finalHtml = await this.wrapHtmlInLayout(mdHtml, context, locale);
      const plainText = text
        ? await this.renderFile(text, context, locale)
        : await this.wrapTextInLayout(
            renderTemplate(md, context, mdPartials, {
              escapeHtmlValues: false,
            }),
            context,
            locale,
          );
      return {
        html: finalHtml,
        text: plainText,
      };
    }

    return {
      html: await this.renderFile(html, context, locale),
      ...(text && { text: await this.renderFile(text, context, locale) }),
    };
  }

  private async wrapHtmlInLayout(
    bodyHtml: string,
    context: object,
    locale: string | undefined,
  ): Promise<string> {
    if (this.layout === undefined) {
      return bodyHtml;
    }
    const layout = await this.find(this.layout, "html", locale);
    if (!layout) {
      throw new MailTemplateError(
        `No layout "${this.layout}" in ${this.dir} (looked for ${this.candidates(this.layout, "html", locale).join(", ")})`,
        { template: this.layout },
      );
    }
    const wrapped = { ...context, body: unsafeHtml(bodyHtml) };
    return renderTemplate(layout, wrapped, await this.partials(layout, locale));
  }

  private async wrapTextInLayout(
    bodyText: string,
    context: object,
    locale: string | undefined,
  ): Promise<string> {
    if (this.layout === undefined) {
      return bodyText;
    }
    const layout = await this.find(this.layout, "text", locale);
    if (!layout) {
      return bodyText;
    }
    const wrapped = { ...context, body: bodyText };
    return renderTemplate(layout, wrapped, await this.partials(layout, locale));
  }

  private markdownCandidates(
    name: string,
    locale: string | undefined,
  ): string[] {
    const tags: string[] = [];
    for (
      let tag = locale ?? "";
      tag;
      tag = tag.slice(
        0,
        Math.max(tag.lastIndexOf("-"), tag.lastIndexOf("_"), 0),
      )
    ) {
      tags.push(tag);
    }
    return [...tags.map((tag) => `${name}.${tag}.md`), `${name}.md`];
  }

  private async findMarkdown(
    name: string,
    locale: string | undefined,
  ): Promise<CompiledTemplate | undefined> {
    for (const candidate of this.markdownCandidates(name, locale)) {
      const template = await this.load(candidate, "text");
      if (template) {
        return template;
      }
    }
    return undefined;
  }

  /** The template with its partials, wrapped in the layout (the text layout only if there is one). */
  private async renderFile(
    template: CompiledTemplate,
    context: object,
    locale: string | undefined,
  ): Promise<string> {
    const body = renderTemplate(
      template,
      context,
      await this.partials(template, locale),
    );
    if (this.layout === undefined) {
      return body;
    }
    const layout = await this.find(this.layout, template.kind, locale);
    if (!layout) {
      if (template.kind === "text") {
        return body;
      }
      throw new MailTemplateError(
        `No layout "${this.layout}" in ${this.dir} (looked for ${this.candidates(this.layout, "html", locale).join(", ")})`,
        { template: this.layout },
      );
    }
    // SafeHtml, so the layout inserts it as it is with either {{{ body }}} or {{ body }}
    const wrapped = {
      ...context,
      body: template.kind === "html" ? unsafeHtml(body) : body,
    };
    return renderTemplate(layout, wrapped, await this.partials(layout, locale));
  }

  /** Every partial `template` includes, directly or through other partials, by name. */
  private async partials(
    template: CompiledTemplate,
    locale: string | undefined,
    found = new Map<string, CompiledTemplate>(),
  ): Promise<Map<string, CompiledTemplate>> {
    const isMarkdown = template.shownAs.endsWith(".md");
    for (const { name, at } of template.partials) {
      if (found.has(name)) {
        continue;
      }
      const partial = isMarkdown
        ? ((await this.findMarkdown(`partials/${name}`, locale)) ??
            (await this.find(`partials/${name}`, "text", locale)))
        : await this.find(`partials/${name}`, template.kind, locale);
      if (!partial) {
        const lookedFor = isMarkdown
          ? [
              ...this.markdownCandidates(`partials/${name}`, locale),
              ...this.candidates(`partials/${name}`, "text", locale),
            ]
          : this.candidates(`partials/${name}`, template.kind, locale);
        throw new MailTemplateError(
          `no partial "${name}" (looked for ${lookedFor.join(", ")})`,
          { file: template.file, shownAs: template.shownAs, ...at },
        );
      }
      found.set(name, partial);
      await this.partials(partial, locale, found);
    }
    return found;
  }

  private async find(
    name: string,
    kind: TemplateKind,
    locale: string | undefined,
  ): Promise<CompiledTemplate | undefined> {
    for (const candidate of this.candidates(name, kind, locale)) {
      const template = await this.load(candidate, kind);
      if (template) {
        return template;
      }
    }
    return undefined;
  }

  /** `name.pt-BR.html`, `name.pt.html`, `name.html`: the most specific locale first. */
  private candidates(
    name: string,
    kind: TemplateKind,
    locale: string | undefined,
  ): string[] {
    const tags: string[] = [];
    for (
      let tag = locale ?? "";
      tag;
      tag = tag.slice(
        0,
        Math.max(tag.lastIndexOf("-"), tag.lastIndexOf("_"), 0),
      )
    ) {
      tags.push(tag);
    }
    return [
      ...tags.map((tag) => `${name}.${tag}${EXTENSIONS[kind]}`),
      `${name}${EXTENSIONS[kind]}`,
    ];
  }

  private load(
    file: string,
    kind: TemplateKind,
  ): Promise<CompiledTemplate | undefined> {
    if (!this.cache) {
      return this.read(file, kind);
    }
    let template = this.files.get(file);
    if (!template) {
      template = this.read(file, kind);
      this.files.set(file, template);
      // A file that failed to compile is read again next time
      template.catch(() => this.files.delete(file));
    }
    return template;
  }

  private async read(
    file: string,
    kind: TemplateKind,
  ): Promise<CompiledTemplate | undefined> {
    const path = join(this.dir, file);
    const prefix = this.dir.endsWith(sep) ? this.dir : this.dir + sep;
    // Names are checked before they get here; this holds even if that check ever changes
    if (!path.startsWith(prefix)) {
      throw new MailTemplateError(
        `The template file ${file} is outside ${this.dir}`,
      );
    }
    let source: string;
    try {
      source = await Bun.file(path).text();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
        if (this.embeddedFiles || isStandaloneExecutable()) {
          const embedded = findEmbeddedFile(file, this.embeddedFiles);
          if (embedded) {
            source = await embedded.text();
            return compileTemplate(source, { path, shownAs: file, kind });
          }
        }
        return undefined;
      }
      throw error;
    }
    return compileTemplate(source, { path, shownAs: file, kind });
  }
}
