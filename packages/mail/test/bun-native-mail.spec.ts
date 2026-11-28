import { describe, expect, it } from "bun:test";
import { join, removePath } from "@bunest/core";
import { FileTemplateEngine, unsafeHtml } from "../src/index";
import { hasValidMxRecord, resolveMxRecords } from "../src/smtp/index";

describe("Wave 5 — @bunest/mail Bun 1.4.5 Native APIs (Bun.markdown, embeddedFiles, Bun.dns.resolveMx)", () => {
  it("FileTemplateEngine renders .md templates via Bun.markdown.html(), escapes XSS in {{ vars }}, and cleans up temp dir", async () => {
    const dir = join(
      "/tmp",
      `bunest-mail-md-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const mdPath = join(dir, "welcome.md");
    await Bun.write(
      mdPath,
      "# Welcome {{ name }}\n\nEnjoy **Bunest**! {{{ trusted }}}",
    );

    try {
      const engine = new FileTemplateEngine({ dir });
      const rendered = await engine.render(
        "welcome",
        {
          name: '<script>alert(1)</script><img src=x onerror=alert(2)>',
          trusted: unsafeHtml("<em>VIP</em>"),
        },
        { locale: undefined },
      );

      // HTML output MUST escape user-supplied HTML tags (no XSS) while preserving Markdown & SafeHtml
      expect(rendered.html).not.toContain("<script>");
      expect(rendered.html).not.toContain("<img ");
      expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(rendered.html).toContain("<strong>Bunest</strong>");
      expect(rendered.html).toContain("<em>VIP</em>");

      // Plain-text fallback retains unescaped readable text
      expect(rendered.text).toContain("# Welcome <script>alert(1)</script>");
    } finally {
      await removePath(dir, { recursive: true, force: true });
    }
  });

  it("FileTemplateEngine supports .md locale fallback, HTML/text layouts, .md partials, and explicit .txt precedence", async () => {
    const dir = join(
      "/tmp",
      `bunest-mail-md-feat-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await Bun.write(
      join(dir, "layout.html"),
      "<html><body>{{{ body }}}</body></html>",
    );
    await Bun.write(join(dir, "layout.txt"), "TEXT_HEADER\n{{ body }}\nTEXT_FOOTER");
    await Bun.write(join(dir, "partials", "sig.md"), "-- *{{ team }}*");
    await Bun.write(
      join(dir, "welcome.vi.md"),
      "Xin chao **{{ name }}**\n\n{{> sig }}",
    );
    await Bun.write(join(dir, "welcome.md"), "Hello **{{ name }}**\n\n{{> sig }}");
    await Bun.write(join(dir, "with-txt.md"), "# Markdown {{ name }}");
    await Bun.write(join(dir, "with-txt.txt"), "Explicit plain text for {{ name }}");

    try {
      const engine = new FileTemplateEngine({ dir, layout: "layout" });

      // Locale match: vi-VN falls back to welcome.vi.md
      const vi = await engine.render(
        "welcome",
        { name: "An", team: "Bunest" },
        { locale: "vi-VN" },
      );
      expect(vi.html).toContain("<html><body>");
      expect(vi.html).toContain("<strong>An</strong>");
      expect(vi.html).toContain("<em>Bunest</em>");
      expect(vi.text).toContain("TEXT_HEADER");
      expect(vi.text).toContain("Xin chao **An**");
      expect(vi.text).toContain("TEXT_FOOTER");

      // Unmatched locale falls back to welcome.md
      const en = await engine.render(
        "welcome",
        { name: "Bob", team: "Bunest" },
        { locale: "fr" },
      );
      expect(en.html).toContain("<strong>Bob</strong>");

      // Explicit .txt takes precedence over rendered Markdown for text part
      const explicitTxt = await engine.render(
        "with-txt",
        { name: "Cara" },
        { locale: undefined },
      );
      expect(explicitTxt.html).toContain("<h1>Markdown Cara</h1>");
      expect(explicitTxt.text).toContain("Explicit plain text for Cara");
      expect(explicitTxt.text).not.toContain("# Markdown");

      // Missing template error mentions both .html and .md candidates
      await expect(
        engine.render("missing-tpl", {}, { locale: undefined }),
      ).rejects.toThrow(/missing-tpl\.md/);
    } finally {
      await removePath(dir, { recursive: true, force: true });
    }
  });

  it("FileTemplateEngine falls back to embeddedFiles for standalone compiled binaries", async () => {
    const embedded = [new File(["# Embedded {{ item }}"], "receipt.md")];
    const engine = new FileTemplateEngine({
      dir: "/non-existent-mail-templates-dir",
      embeddedFiles: embedded,
    });
    const rendered = await engine.render(
      "receipt",
      { item: "Pro" },
      { locale: undefined },
    );
    expect(rendered.html).toContain("<h1>Embedded Pro</h1>");
    expect(rendered.text).toBe("# Embedded Pro");
  });

  it("resolveMxRecords and hasValidMxRecord extract email domains, sort by ascending priority, reject null-MX, and handle errors", async () => {
    expect(await resolveMxRecords("")).toEqual([]);
    expect(await resolveMxRecords("   ")).toEqual([]);

    const bunDns = (
      Bun as unknown as {
        dns: {
          resolveMx?: (
            domain: string,
          ) => Promise<Array<{ exchange: string; priority: number }>>;
        };
      }
    ).dns;
    const origResolveMx = bunDns.resolveMx;
    const queriedDomains: string[] = [];

    try {
      bunDns.resolveMx = async (domain: string) => {
        queriedDomains.push(domain);
        if (domain === "example.com") {
          return [
            { exchange: "mx2.example.com", priority: 20 },
            { exchange: "mx1.example.com", priority: 10 },
            { exchange: "mx3.example.com", priority: 30 },
          ];
        }
        if (domain === "nullmx.invalid") {
          return [{ exchange: ".", priority: 0 }];
        }
        if (domain === "empty.invalid") {
          return [];
        }
        throw new Error("ENOTFOUND");
      };

      const sorted = await resolveMxRecords("alice@example.com");
      expect(queriedDomains).toEqual(["example.com"]);
      expect(sorted).toEqual([
        { exchange: "mx1.example.com", priority: 10 },
        { exchange: "mx2.example.com", priority: 20 },
        { exchange: "mx3.example.com", priority: 30 },
      ]);

      expect(await hasValidMxRecord("alice@example.com")).toBe(true);
      expect(await hasValidMxRecord("nullmx.invalid")).toBe(false);
      expect(await hasValidMxRecord("empty.invalid")).toBe(false);
      expect(await hasValidMxRecord("boom.invalid")).toBe(false);
    } finally {
      bunDns.resolveMx = origResolveMx;
    }
  });
});
