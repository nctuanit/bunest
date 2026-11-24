import { describe, expect, it } from "bun:test";
import { ensureDir, join, removePath } from "@bunest/core";
import {
  html,
  InMemoryMailTransport,
  Mailer,
  MailEvents,
  MailMessage,
  MailMessageError,
  MailModule,
  unsafeHtml,
} from "../src";
import { Test } from "@bunest/testing";
import { extractLinks, htmlToText } from "../src/message/text.util";

async function createMailer(defaults: Record<string, unknown> = {}) {
  const transport = new InMemoryMailTransport();
  const mod = await Test.createTestingModule({
    imports: [
      MailModule.forRoot({
        transport,
        from: "Orders <orders@example.com>",
        ...defaults,
      }),
    ],
  }).compile();
  return { mod, mailer: mod.get(Mailer), transport };
}

describe("html tagged template & unsafeHtml", () => {
  it("auto-escapes interpolated values and preserves nested SafeHtml", () => {
    const user = "<script>alert(\"xss\")</script> & 'quotes'";
    const items = ["A & B", "<b>bold</b>"];
    const rendered = html`<p>Hi ${user}</p><ul>${items.map((item) => html`<li>${item}</li>`)}</ul>${false}${null}${undefined}${unsafeHtml("<em>ok</em>")}`;
    expect(rendered.value).toBe(
      "<p>Hi &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#x27;quotes&#x27;</p>" +
        "<ul><li>A &amp; B</li><li>&lt;b&gt;bold&lt;/b&gt;</li></ul><em>ok</em>",
    );
    expect(String(rendered)).toBe(rendered.value);
    expect(Object.isFrozen(rendered)).toBe(true);
  });

  it("allows quoted attributes and rejects unquoted or raw tag interpolations", () => {
    const url = "https://example.com/?a=1&b=2";
    const ok = html`<a href="${url}">Link</a>`;
    expect(ok.value).toBe(
      '<a href="https://example.com/?a=1&amp;b=2">Link</a>',
    );

    expect(() => html`<a href=${url}>Link</a>`).toThrow(TypeError);
    expect(() => html`<a ${"onclick=evil()"}>Link</a>`).toThrow(TypeError);

    // Trusted SafeHtml attributes are allowed
    const attr = unsafeHtml('data-id="1"');
    expect(html`<div ${attr}>ok</div>`.value).toBe('<div data-id="1">ok</div>');

    // Bare `<` in text and HTML comments are treated as text
    expect(html`<p>1 < 2 and ${"a < b"}</p><!-- ${"note"} -->`.value).toBe(
      "<p>1 < 2 and a &lt; b</p><!-- note -->",
    );
  });

  it("validates unsafeHtml input", () => {
    expect(() => unsafeHtml(123 as unknown as string)).toThrow(TypeError);
  });
});

describe("MailMessage validation, normalization & RFC 5322 / MIME", () => {
  it("forbids direct instantiation of MailMessage", () => {
    expect(() => new MailMessage({} as never, Symbol("bad") as never)).toThrow(
      TypeError,
    );
  });

  it("builds immutable MailMessage with derived text, deduplicated envelope, IDNA, and deterministic idempotency Message-ID", async () => {
    const { mod, mailer } = await createMailer({
      replyTo: "Support <support@example.com>",
      headers: { "X-App": "Bunest", "X-Override": "default" },
    });

    const msg1 = await mailer.render({
      to: [
        "Ada Lovelace <ada@münchen.de>",
        { name: "Bob, Jr.", address: "bob@example.com" },
      ],
      cc: "ADA@xn--mnchen-3ya.de",
      bcc: "secret@example.com",
      subject: "Hello Café — Order #42",
      html: html`<h1>Order #42</h1>
        <p>Track <a href="https://shop.example.com/o/42?a=1&b=2">here</a>.</p>`,
      headers: { "x-override": "custom" },
      locale: "en-US",
    });

    expect(Object.isFrozen(msg1)).toBe(true);
    expect(msg1.from).toEqual({
      name: "Orders",
      address: "orders@example.com",
    });
    expect(msg1.to[0]).toEqual({
      name: "Ada Lovelace",
      address: "ada@xn--mnchen-3ya.de",
    });
    expect(msg1.to[1]).toEqual({
      name: "Bob, Jr.",
      address: "bob@example.com",
    });
    expect(msg1.envelope).toEqual({
      from: "orders@example.com",
      to: ["ada@xn--mnchen-3ya.de", "bob@example.com", "secret@example.com"],
    });
    expect(msg1.headers).toEqual({ "X-App": "Bunest", "x-override": "custom" });
    expect(msg1.text).toContain("Order #42");
    expect(msg1.text).toContain("here (https://shop.example.com/o/42?a=1&b=2)");
    expect(msg1.internationalized).toBe(false);

    const mime = msg1.toMime().toString("utf8");
    expect(mime).toContain("From: Orders <orders@example.com>\r\n");
    expect(mime).toContain("Reply-To: Support <support@example.com>\r\n");
    expect(mime).toContain(
      'To: Ada Lovelace <ada@xn--mnchen-3ya.de>, "Bob, Jr." <bob@example.com>',
    );
    expect(mime).not.toContain("secret@example.com");
    expect(mime).toContain("MIME-Version: 1.0\r\n");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("=?UTF-8?");
    // toMime returns a fresh copy every time
    const bufA = msg1.toMime();
    const bufB = msg1.toMime();
    expect(bufA).not.toBe(bufB);
    expect(bufA.equals(bufB)).toBe(true);

    // Deterministic Message-ID with idempotencyKey
    const res1 = await mailer.send({
      to: "ada@example.com",
      subject: "Once",
      text: "body",
      idempotencyKey: "order-42",
    });
    const res2 = await mailer.send({
      to: "ada@example.com",
      subject: "Once",
      text: "body",
      idempotencyKey: "order-42",
    });
    expect(res1.messageId).toBe(res2.messageId);
    expect(res1.messageId.endsWith("@example.com>")).toBe(true);

    await mod.close();
  });

  it("detects internationalized local parts (SMTPUTF8)", async () => {
    const { mod, mailer } = await createMailer();
    const msg = await mailer.render({
      to: "josé@example.com",
      subject: "UTF8",
      text: "hi",
    });
    expect(msg.internationalized).toBe(true);
    await mod.close();
  });

  it("builds multipart/mixed + multipart/alternative + multipart/related with inline and regular attachments from strings, streams, and files", async () => {
    const dir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-mail-att-${crypto.randomUUID()}`,
    );
    await ensureDir(dir);
    try {
      const filePath = join(dir, "report.pdf");
      await Bun.write(filePath, Buffer.from("%PDF-1.7 sample"));

      const asyncStream = (async function* () {
        yield Buffer.from("csv,");
        yield Buffer.from("data");
      })();
      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("web-bytes"));
          controller.close();
        },
      });

      const { mod, mailer } = await createMailer();
      const msg = await mailer.render({
        to: "ada@example.com",
        subject: "Attachments",
        html: '<p>See <img src="cid:logo@example.com"></p>',
        text: "See logo.\n.dot line",
        attachments: [
          {
            cid: "logo@example.com",
            content: Buffer.from([137, 80, 78, 71]),
            contentType: "image/png",
          },
          { path: filePath },
          { filename: "data.csv", content: asyncStream },
          {
            filename:
              "ümlaut-long-file-name-for-rfc2231-encoding-verification.txt",
            content: webStream,
          },
        ],
      });

      expect(msg.attachments).toHaveLength(4);
      expect(msg.attachments[0]?.disposition).toBe("inline");
      expect(msg.attachments[1]?.filename).toBe("report.pdf");
      expect(msg.attachments[1]?.contentType).toBe("application/pdf");
      expect(msg.attachments[2]?.content.toString("utf8")).toBe("csv,data");
      expect(msg.attachments[3]?.content.toString("utf8")).toBe("web-bytes");

      const mime = msg.toMime().toString("utf8");
      expect(mime).toContain("multipart/mixed");
      expect(mime).toContain("multipart/alternative");
      expect(mime).toContain("multipart/related");
      expect(mime).toContain("Content-ID: <logo@example.com>");
      expect(mime).toContain("Content-Disposition: inline");
      expect(mime).toContain('filename="report.pdf"');
      expect(mime).toContain("filename*0*=UTF-8''");
      // Leading dot in text body encoded via quoted-printable
      expect(mime).toContain("=2Edot line");

      await mod.close();
    } finally {
      await removePath(dir, { recursive: true, force: true });
    }
  });

  it("rejects header injection, reserved headers, malformed addresses, missing body/recipients, URL attachment paths, and duplicate CIDs", async () => {
    const { mod, mailer } = await createMailer();

    await expect(
      mailer.render({
        to: "a@b.com",
        subject: "Line\r\nBcc: evil@x.com",
        text: "hi",
      }),
    ).rejects.toThrow(MailMessageError);

    await expect(
      mailer.render({ to: "a@b.com, c@d.com", subject: "hi", text: "hi" }),
    ).rejects.toThrow(MailMessageError);

    await expect(
      mailer.render({
        to: "Doe, Jane <jane@example.com>",
        subject: "hi",
        text: "hi",
      }),
    ).rejects.toThrow(MailMessageError);

    await expect(
      mailer.render({
        to: "a@b.com",
        subject: "hi",
        text: "hi",
        headers: { From: "spoof@x.com" },
      }),
    ).rejects.toThrow(MailMessageError);

    await expect(
      mailer.render({
        to: "a@b.com",
        subject: "hi",
        text: "hi",
        headers: { "X-Tag": "1", "x-tag": "2" },
      }),
    ).rejects.toThrow(MailMessageError);

    await expect(
      mailer.render({ to: "a@b.com", subject: "hi" }),
    ).rejects.toThrow(MailMessageError);

    await expect(
      mailer.send({ subject: "No recipients", text: "hi" }),
    ).rejects.toThrow(MailMessageError);

    await expect(
      mailer.render({
        to: "a@b.com",
        subject: "hi",
        text: "hi",
        attachments: [{ path: "https://example.com/secret" }],
      }),
    ).rejects.toThrow(MailMessageError);

    await expect(
      mailer.render({
        to: "a@b.com",
        subject: "hi",
        text: "hi",
        attachments: [
          { cid: "dup", content: "1" },
          { cid: "dup", content: "2" },
        ],
      }),
    ).rejects.toThrow(MailMessageError);

    await mod.close();
  });

  it("converts HTML to plain text and extracts links accurately", () => {
    const source = `
      <!-- ignore -->
      <style>body { color: red }</style>
      <h1>Welcome &amp; Hello</h1>
      <p>Click <a href="https://example.com/verify?a=1&amp;b=2">Verify</a> or <a href="mailto:hi@example.com">email us</a>.</p>
      <ul><li>First</li><li>Second</li></ul>
      <hr>
      <p>Plain &euro;10</p>
    `;
    const text = htmlToText(source);
    expect(text).toContain("Welcome & Hello");
    expect(text).toContain("Verify (https://example.com/verify?a=1&b=2)");
    expect(text).toContain("email us (hi@example.com)");
    expect(text).toContain("- First");
    expect(text).toContain("- Second");
    expect(text).toContain("----");
    expect(text).toContain("Plain €10");

    const links = extractLinks(
      '<a href="https://a.test/1?x=1&amp;y=2">1</a><a href="#top">top</a><a href="cid:img">img</a>',
      "Also visit https://a.test/1?x=1&y=2 and https://b.test/2.",
    );
    expect(links).toEqual(["https://a.test/1?x=1&y=2", "https://b.test/2"]);
  });
});
