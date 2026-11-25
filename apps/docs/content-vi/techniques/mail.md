# Gửi thư (Mail)

**`@bunest/mail`** cung cấp các lớp mail định kiểu chặt chẽ, mẫu HTML tự động thoát ký tự đặc biệt (auto-escaped), tệp đính kèm, sự kiện vòng đời (lifecycle events) và các transport gốc cho SMTP, Resend, Postmark, SendGrid, Amazon SES, file/log và kiểm thử trong bộ nhớ—không có phụ thuộc runtime bên ngoài.

## Cài đặt

```bash
bun add @bunest/mail
```

## Thiết lập Module

Cấu hình `MailModule.forRoot()` với transport bạn chọn (`SmtpTransport`, `ResendTransport`, `PostmarkTransport`, `SendGridTransport`, `SesTransport`, `LogMailTransport`, `FileMailTransport`, hoặc `InMemoryMailTransport` cho kiểm thử):

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { MailModule, ResendTransport } from "@bunest/mail";

@Module({
  imports: [
    MailModule.forRoot({
      defaultFrom: "noreply@example.com",
      transport: new ResendTransport({
        apiKey: process.env.RESEND_API_KEY!,
      }),
    }),
  ],
})
export class AppModule {}
```

## Gửi Email

Inject `MailService` để gửi thư dạng văn bản thuần, HTML hoặc thư kết xuất từ mẫu (template):

@@filename(notifications.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { MailService } from "@bunest/mail";

@Injectable()
export class NotificationsService {
  constructor(private readonly mail: MailService) {}

  async sendWelcome(to: string, name: string) {
    await this.mail.send({
      to,
      subject: "Welcome to Bunest",
      html: `<p>Hi ${name}, welcome aboard!</p>`,
      text: `Hi ${name}, welcome aboard!`,
    });
  }
}
```

> info **Kiểm thử với `InMemoryMailTransport`** Thay thế bằng `InMemoryMailTransport` bên trong `Test.createTestingModule()` để kiểm tra các thư đã gửi mà không cần gọi mạng hay máy chủ SMTP.
