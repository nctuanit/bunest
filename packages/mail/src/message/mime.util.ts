import { ensureSuffix, randomToken } from "@bunest/core/common";
import type {
  MailAddress,
  MailAttachment,
} from "../interfaces/mail-message.interface";
import { base64Lines, encodeTextBody } from "./encoding.util";
import {
  addressHeader,
  encodePhrase,
  encodeText,
  foldHeader,
  formatDate,
  mimeParameter,
} from "./headers.util";

export interface MimeMessageInput {
  readonly from: MailAddress;
  readonly replyTo: readonly MailAddress[];
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly subject: string;
  readonly date: Date;
  readonly messageId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly html?: string;
  readonly text?: string;
  readonly attachments: readonly MailAttachment[];
}

interface MimeLeaf {
  headers: string[];
  body: string;
}

interface MimeMultipart {
  subtype: "mixed" | "alternative" | "related";
  parts: MimeNode[];
}

type MimeNode = MimeLeaf | MimeMultipart;

/**
 * The message as RFC 5322 + MIME (RFC 2045-2049). Structure, leaving out levels that
 * would hold a single part:
 *
 * ```text
 * multipart/mixed
 * ├─ multipart/alternative
 * │  ├─ text/plain
 * │  └─ multipart/related
 * │     ├─ text/html
 * │     └─ inline images (Content-ID)
 * └─ attachments
 * ```
 *
 * Inline parts sit next to the HTML they belong to, not above the alternative, so a
 * client showing the text version doesn't list them as attachments. `Bcc` is never
 * written. Every line ends with CRLF and fits in 998 characters.
 */
export function buildMime(message: MimeMessageInput): Buffer {
  const headers = [addressHeader("From", [message.from])];
  if (message.replyTo.length) {
    headers.push(addressHeader("Reply-To", message.replyTo));
  }
  if (message.to.length) {
    headers.push(addressHeader("To", message.to));
  }
  if (message.cc.length) {
    headers.push(addressHeader("Cc", message.cc));
  }
  headers.push(foldHeader("Subject", encodeText(message.subject, "Subject")));
  headers.push(`Date: ${formatDate(message.date)}`);
  headers.push(`Message-ID: ${message.messageId}`);
  for (const [name, value] of Object.entries(message.headers)) {
    headers.push(foldHeader(name, encodeText(value, name)));
  }
  headers.push("MIME-Version: 1.0");
  const mime = serialize(structure(message), headers);
  return Buffer.from(ensureSuffix(mime, "\r\n"), "utf8");
}

function structure(message: MimeMessageInput): MimeNode {
  const inline = message.html
    ? message.attachments.filter((a) => a.disposition === "inline")
    : [];
  const attached = message.attachments.filter((a) => !inline.includes(a));
  const text: MimeNode | undefined =
    message.text !== undefined ? textLeaf("plain", message.text) : undefined;
  let htmlNode: MimeNode | undefined =
    message.html !== undefined ? textLeaf("html", message.html) : undefined;
  if (htmlNode && inline.length) {
    htmlNode = {
      subtype: "related",
      parts: [htmlNode, ...inline.map(attachmentLeaf)],
    };
  }
  let body: MimeNode =
    text && htmlNode
      ? { subtype: "alternative", parts: [text, htmlNode] }
      : (htmlNode ?? text ?? textLeaf("plain", ""));
  if (attached.length) {
    body = {
      subtype: "mixed",
      parts: [body, ...attached.map(attachmentLeaf)],
    };
  }
  return body;
}

function textLeaf(subtype: "plain" | "html", content: string): MimeLeaf {
  const { encoding, body } = encodeTextBody(content);
  return {
    headers: [
      `Content-Type: text/${subtype}; charset=utf-8`,
      `Content-Transfer-Encoding: ${encoding}`,
    ],
    body,
  };
}

function attachmentLeaf(attachment: MailAttachment): MimeLeaf {
  const type = [attachment.contentType];
  const disposition: string[] = [attachment.disposition];
  if (attachment.filename !== undefined) {
    // `name` on Content-Type as an encoded-word is not standard, but it is what Outlook
    // and older clients read; RFC 2231 `filename*` is the standard, for everyone else.
    const name = encodePhrase(attachment.filename).join("");
    const quoted = name.startsWith('"') ? name : `"${name}"`;
    type.push(` name=${quoted}`);
    disposition.push(
      ...mimeParameter("filename", attachment.filename).map((p) => ` ${p}`),
    );
  }
  const headers = [
    foldHeader("Content-Type", withSemicolons(type)),
    "Content-Transfer-Encoding: base64",
    foldHeader("Content-Disposition", withSemicolons(disposition)),
  ];
  if (attachment.cid) {
    headers.push(`Content-ID: <${attachment.cid}>`);
  }
  return { headers, body: base64Lines(attachment.content) };
}

/** `['a', ' b', ' c']` -> `['a;', ' b;', ' c']`: parameter separators, with fold points after them. */
function withSemicolons(tokens: string[]): string[] {
  return tokens.map((token, i) =>
    i < tokens.length - 1 ? `${token};` : token,
  );
}

function serialize(node: MimeNode, headers: string[]): string {
  if ("body" in node) {
    return [...headers, ...node.headers].join("\r\n") + "\r\n\r\n" + node.body;
  }
  const boundary = `=_${randomToken(18)}`;
  const own = [
    ...headers,
    foldHeader("Content-Type", [
      `multipart/${node.subtype};`,
      ` boundary="${boundary}"`,
    ]),
  ];
  const parts = node.parts.map(
    (part) => `--${boundary}\r\n${serialize(part, [])}\r\n`,
  );
  return `${own.join("\r\n")}\r\n\r\n${parts.join("")}--${boundary}--\r\n`;
}
