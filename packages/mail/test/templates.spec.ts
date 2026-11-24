import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ensureDir, join, removePath } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  FileTemplateEngine,
  html,
  InMemoryMailTransport,
  Mailer,
  MailModule,
  MailTemplateEngine,
  MailTemplateError,
} from "../src";

describe("FileTemplateEngine & MailTemplateEngine", () => {
  let dir: string;

  beforeAll(async () => {
    dir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-mail-tpl-${crypto.randomUUID()}`,
    );
    await ensureDir(join(dir, "partials"));
    await ensureDir(join(dir, "nested"));

    await Bun.write(
      join(dir, "layout.html"),
      "<!doctype html><html><body><header>{{ title }}</header><main>{{{ body }}}</main>{{> footer}}</body></html>",
    );
    await Bun.write(
      join(dir, "layout.txt"),
      "=== {{ title }} ===\n{{ body }}\n{{> footer}}",
    );
    await Bun.write(
      join(dir, "partials", "footer.html"),
      "<footer>Thanks, {{ company }}</footer>",
    );
    await Bun.write(
      join(dir, "partials", "footer.txt"),
      "-- Thanks, {{ company }}",
    );
    await Bun.write(
      join(dir, "partials", "footer.pl.html"),
      "<footer>Dziękujemy, {{ company }}</footer>",
    );
    await Bun.write(
      join(dir, "order.html"),
      [
        "{{! comment ignored }}",
        "<p>Hi {{ customer.name }}</p>",
        "{{#if paid}}",
        "  <p>Paid!</p>",
        "{{else if pending}}",
        "  <p>Pending</p>",
        "{{else}}",
        "  <p>Unpaid</p>",
        "{{/if}}",
        "{{#unless archived}}<span>Active</span>{{/unless}}",
        "<ul>",
        "{{#each items}}",
        '  <li data-idx="{{ @index }}" data-first="{{ @first }}" data-last="{{ @last }}">{{ this.name }} ({{ ../currency }} / {{ @root.company }})</li>',
        "{{else}}",
        "  <li>Empty</li>",
        "{{/each}}",
        "</ul>",
        "<div>{{{ rawHtml }}}</div><div>{{ safeHtml }}</div>",
      ].join("\n"),
    );
    await Bun.write(
      join(dir, "order.txt"),
      [
        "Hi {{ customer.name }}",
        "{{#each items}}",
        "- {{ @index }}: {{ name }} ({{ currency }})",
        "{{/each}}",
      ].join("\n"),
    );
    await Bun.write(
      join(dir, "order.pl.html"),
      "<p>Cześć {{ customer.name }}</p>",
    );
    await Bun.write(join(dir, "bad-attr.html"), "<a href={{ url }}>Click</a>");
    await Bun.write(join(dir, "unclosed.html"), "{{#if ok}}<p>hi</p>");
    await Bun.write(join(dir, "mismatch.html"), "{{#if ok}}\n{{/each}}");
    await Bun.write(join(dir, "partials", "loop-a.html"), "{{> loop-b}}");
    await Bun.write(join(dir, "partials", "loop-b.html"), "{{> loop-a}}");
    await Bun.write(join(dir, "cycle.html"), "{{> loop-a}}");
    await Bun.write(
      join(dir, "nested", "proto.html"),
      "<p>{{ constructor }}-{{ toString }}-\\{{ literal }}</p>",
    );
  });

  afterAll(async () => {
    await removePath(dir, { recursive: true, force: true });
  });

  it("renders HTML and TXT templates with layout, partials, blocks, loops, escaping, and SafeHtml", async () => {
    const engine = new FileTemplateEngine({ dir, layout: "layout" });
    const out = await engine.render(
      "order",
      {
        title: "Receipt",
        company: "Acme",
        currency: "USD",
        customer: { name: "<Ada>" },
        paid: false,
        pending: true,
        archived: false,
        items: [{ name: "Widget" }, { name: "Gadget" }],
        rawHtml: "<strong>RAW</strong>",
        safeHtml: html`<em>${"<safe>"}</em>`,
      },
      { locale: undefined },
    );

    expect(out.html).toContain("<header>Receipt</header>");
    expect(out.html).toContain("<p>Hi &lt;Ada&gt;</p>");
    expect(out.html).toContain("<p>Pending</p>");
    expect(out.html).toContain("<span>Active</span>");
    expect(out.html).toContain(
      'data-idx="0" data-first="true" data-last="false">Widget (USD / Acme)</li>',
    );
    expect(out.html).toContain(
      'data-idx="1" data-first="false" data-last="true">Gadget (USD / Acme)</li>',
    );
    expect(out.html).toContain(
      "<div><strong>RAW</strong></div><div><em>&lt;safe&gt;</em></div>",
    );
    expect(out.html).toContain("<footer>Thanks, Acme</footer>");

    expect(out.text).toBeDefined();
    expect(out.text).toContain("=== Receipt ===");
    expect(out.text).toContain("Hi <Ada>");
    expect(out.text).toContain("- 0: Widget (USD)");
    expect(out.text).toContain("-- Thanks, Acme");
  });

  it("resolves locale fallbacks (pl-PL -> pl -> default) for templates and partials", async () => {
    const engine = new FileTemplateEngine({ dir, layout: "layout" });
    const out = await engine.render(
      "order",
      { title: "Witaj", company: "Acme", customer: { name: "Jan" } },
      { locale: "pl-PL" },
    );
    expect(out.html).toContain("<p>Cześć Jan</p>");
    expect(out.html).toContain("<footer>Dziękujemy, Acme</footer>");
  });

  it("blocks prototype access and supports escaped \\{{ literal", async () => {
    const engine = new FileTemplateEngine({ dir });
    const out = await engine.render("nested/proto", {}, { locale: undefined });
    expect(out.html).toBe("<p>--{{ literal }}</p>");
  });

  it("reports compile and runtime errors as permanent MailTemplateError with line/column", async () => {
    const engine = new FileTemplateEngine({ dir });

    // Unquoted attribute value
    try {
      await engine.render(
        "bad-attr",
        { url: "https://x.test" },
        { locale: undefined },
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MailTemplateError);
      const te = err as MailTemplateError;
      expect(te.permanent).toBe(true);
      expect(te.line).toBe(1);
      expect(te.message).toContain("quote the attribute value");
    }

    // Unclosed block
    await expect(
      engine.render("unclosed", {}, { locale: undefined }),
    ).rejects.toThrow(MailTemplateError);

    // Mismatched close tag with line 2
    try {
      await engine.render("mismatch", {}, { locale: undefined });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MailTemplateError);
      expect((err as MailTemplateError).line).toBe(2);
    }

    // Recursive partials stopped at MAX_PARTIAL_DEPTH
    await expect(
      engine.render("cycle", {}, { locale: undefined }),
    ).rejects.toThrow(MailTemplateError);

    // Invalid template name / path traversal
    await expect(
      engine.render("../secret", {}, { locale: undefined }),
    ).rejects.toThrow(MailTemplateError);

    // Invalid locale
    await expect(
      engine.render("order", {}, { locale: "../bad" }),
    ).rejects.toThrow(MailTemplateError);

    // Missing template
    await expect(
      engine.render("does-not-exist", {}, { locale: undefined }),
    ).rejects.toThrow(MailTemplateError);
  });

  it("re-reads modified files when cache: false", async () => {
    const dynamicFile = join(dir, "dynamic.html");
    await Bun.write(dynamicFile, "<p>v1 {{ x }}</p>");
    const engine = new FileTemplateEngine({ dir, cache: false });

    const first = await engine.render(
      "dynamic",
      { x: "a" },
      { locale: undefined },
    );
    expect(first.html).toBe("<p>v1 a</p>");

    await Bun.write(dynamicFile, "<p>v2 {{ x }}</p>");
    const second = await engine.render(
      "dynamic",
      { x: "a" },
      { locale: undefined },
    );
    expect(second.html).toBe("<p>v2 a</p>");
  });

  it("integrates FileTemplateEngine and custom MailTemplateEngine with MailModule", async () => {
    const transport = new InMemoryMailTransport();
    const mod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport,
          templates: new FileTemplateEngine({ dir, layout: "layout" }),
          from: "app@example.com",
        }),
      ],
    }).compile();

    const mailer = mod.get(Mailer);
    await mailer.send({
      to: "user@example.com",
      subject: "Your Order",
      template: "order",
      context: {
        title: "Hi",
        company: "Acme",
        customer: { name: "Ada" },
        items: [],
      },
    });

    const sent = transport.assertSent({
      template: "order",
      to: "user@example.com",
    });
    expect(sent.html).toContain("<li>Empty</li>");
    await mod.close();

    // Custom class template engine
    class CustomEngine extends MailTemplateEngine {
      override render(name: string, context: object) {
        return `<div>${name}:${JSON.stringify(context)}</div>`;
      }
    }
    const transport2 = new InMemoryMailTransport();
    const mod2 = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: transport2,
          templates: CustomEngine,
          from: "app@example.com",
        }),
      ],
    }).compile();
    const mailer2 = mod2.get(Mailer);
    const preview = await mailer2.render({
      subject: "Custom",
      template: "welcome",
      context: { ok: true },
    });
    expect(preview.html).toBe('<div>welcome:{"ok":true}</div>');
    expect(preview.template).toBe("welcome");
    await mod2.close();
  });
});
