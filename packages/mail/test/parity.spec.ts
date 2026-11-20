import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Mail from "../src";

const EXPECTED_RUNTIME_EXPORTS = [
  "MailModule",
  "MAIL_MODULE_OPTIONS",
  "Mailer",
  "MailMessage",
  "html",
  "unsafeHtml",
  "FileTemplateEngine",
  "MailTemplateEngine",
  "MailTransport",
  "SmtpTransport",
  "ResendTransport",
  "PostmarkTransport",
  "SendGridTransport",
  "SesTransport",
  "FileMailTransport",
  "LogMailTransport",
  "InMemoryMailTransport",
  "SentMail",
  "MailEvents",
  "MailError",
  "MailConnectionError",
  "MailMessageError",
  "MailProviderError",
  "MailRecipientsRejectedError",
  "MailSmtpError",
  "MailTemplateError",
  "MailTimeoutError",
] as const;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("@bunest/mail NestJS v12 API parity & ADR-008 guardrails", () => {
  it("exports all 27 runtime symbols matching @nestjs/mail@0.0.2", () => {
    const actual = Object.keys(Mail).sort();
    const expected = [...EXPECTED_RUNTIME_EXPORTS].sort();
    expect(actual).toEqual(expected);
  });

  it("has zero rxjs imports anywhere under packages/mail/src/", () => {
    const files = walkTs(join(import.meta.dir, "..", "src"));
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(/from\s+["']rxjs/);
      expect(content).not.toMatch(/require\(["']rxjs/);
    }
  });
});
