# @bunest/mail

Zero-dependency transactional email module for Bunest with 100% NestJS v12 `@nestjs/mail` API parity: typed `Mailable` classes, auto-escaping `html` tagged templates, built-in `FileTemplateEngine`, RFC 5322/MIME builder, DKIM signing, connection-pooled SMTP, and HTTP provider transports (Resend, Postmark, SendGrid, Amazon SES).

## Features

- **Module & DI**: `MailModule.forRoot()` and `forRootAsync()` (`useFactory`, `useClass`, `useExisting`, `imports`, `isGlobal`), `MAIL_MODULE_OPTIONS`, and graceful shutdown draining.
- **Typed Mail Classes & Inline Sending**: `Mailer.send()` and `Mailer.render()` for inline messages, template messages, and injectable `Mailable<T>` classes.
- **Safe HTML & Templates**: Auto-escaping `html` tagged template literal, explicit `unsafeHtml()` opt-out, context-aware attribute checks, and zero-dependency `FileTemplateEngine` with locales, partials, layouts, and caching.
- **RFC 5322 / MIME & Security**: Strict address validation with IDNA & SMTPUTF8 support, header injection prevention, RFC 2047 encoded-words, RFC 2231 attachment filenames, automatic HTML-to-text derivation, and DKIM signing (`rsa-sha256` & `ed25519-sha256`).
- **Transports**: `SmtpTransport` (native TCP/TLS/STARTTLS, `AUTH PLAIN`/`LOGIN`/`XOAUTH2`, connection pooling, DKIM), `ResendTransport`, `PostmarkTransport`, `SendGridTransport`, `SesTransport` (native AWS SigV4), `InMemoryMailTransport` & `SentMail` (`assertSent`, `assertNotSent`, `failNext`), `FileMailTransport` (`.eml`), and `LogMailTransport`.
- **Resilience & Observability**: Exponential backoff with jitter, `Retry-After` handling, abort signal propagation, structured `MailError` hierarchy, `node:diagnostics_channel` (`nestjs:mail:sent`, `nestjs:mail:failed`), and zero-RxJS `MailEvents.events$`.

## Installation

```bash
bun add @bunest/mail
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import { MailModule, Mailer, SmtpTransport, html } from "@bunest/mail";

@Module({
  imports: [
    MailModule.forRoot({
      transport: new SmtpTransport({
        url: process.env.SMTP_URL ?? "smtp://localhost:1025",
      }),
      from: "Orders <orders@example.com>",
    }),
  ],
})
export class AppModule {}

@Injectable()
export class WelcomeService {
  constructor(private readonly mailer: Mailer) {}

  async sendWelcome(email: string, name: string) {
    await this.mailer.send({
      to: email,
      subject: "Welcome to Bunest",
      html: html`<p>Hello ${name}!</p>`,
    });
  }
}
```

## Key Exports

- **Module & Service**: `MailModule` (`forRoot`, `forRootAsync`), `MAIL_MODULE_OPTIONS`, `Mailer`, `MailMessage`, `MailEvents`
- **HTML & Templates**: `html`, `unsafeHtml`, `FileTemplateEngine`, `MailTemplateEngine`
- **Transports**: `MailTransport`, `SmtpTransport`, `ResendTransport`, `PostmarkTransport`, `SendGridTransport`, `SesTransport`, `InMemoryMailTransport`, `SentMail`, `FileMailTransport`, `LogMailTransport`
- **Errors**: `MailError`, `MailConnectionError`, `MailMessageError`, `MailProviderError`, `MailRecipientsRejectedError`, `MailSmtpError`, `MailTemplateError`, `MailTimeoutError`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
