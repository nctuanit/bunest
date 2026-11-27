# Mail

**`@bunest/mail`** provides typed mail classes, auto-escaped HTML templates, attachments, lifecycle events, and native transports for SMTP, Resend, Postmark, SendGrid, Amazon SES, file/log, and in-memory testing—with zero external runtime dependencies.

## Installation

```bash
bun add @bunest/mail
```

## Module Setup

Configure `MailModule.forRoot()` with your chosen transport (`SmtpTransport`, `ResendTransport`, `PostmarkTransport`, `SendGridTransport`, `SesTransport`, `LogMailTransport`, `FileMailTransport`, or `InMemoryMailTransport` for tests):

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { MailModule, ResendTransport } from "@bunest/mail";

@Module({
  imports: [
    MailModule.forRoot({
      from: "noreply@example.com",
      transport: new ResendTransport({
        apiKey: process.env.RESEND_API_KEY!,
      }),
    }),
  ],
})
export class AppModule {}
```

## Sending Emails

Inject `Mailer` to send plain text, HTML, or template-rendered messages:

@@filename(notifications.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { html, Mailer } from "@bunest/mail";

@Injectable()
export class NotificationsService {
  constructor(private readonly mail: Mailer) {}

  async sendWelcome(to: string, name: string) {
    await this.mail.send({
      to,
      subject: "Welcome to Bunest",
      html: html`<p>Hi ${name}, welcome aboard!</p>`,
      text: `Hi ${name}, welcome aboard!`,
    });
  }
}
```

> info **Testing with `InMemoryMailTransport`** Swap in `InMemoryMailTransport` inside `Test.createTestingModule()` to inspect sent messages without network calls or SMTP servers.
