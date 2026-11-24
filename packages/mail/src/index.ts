// Module and options
export { MailModule } from "./mail.module";
export { MAIL_MODULE_OPTIONS } from "./mail.module-definition";
export type {
  Duration,
  MailBackoffOptions,
  MailModuleAsyncOptions,
  MailModuleOptions,
  MailOptionsFactory,
  MailRetryOptions,
} from "./interfaces/index";

// Sending: the mailer, mail classes, and what they take and return
export { Mailer } from "./mailer.service";
export type {
  Mailable,
  MailableRenderOptions,
  MailableSendOptions,
  MailAddress,
  MailAddressInput,
  MailAttachment,
  MailAttachmentInput,
  MailContent,
  MailDeliveryOptions,
  MailRenderContext,
  MailRenderOptions,
  MailSendOptions,
  MailSendResult,
  MailTemplateContent,
} from "./interfaces/index";
export { MailMessage } from "./message/mail-message";

// Writing HTML: auto-escaping template, explicit opt-out
export { html, unsafeHtml, type SafeHtml } from "./message/html.util";

// Templates: the built-in engine over template files, and the contract for your own
export { FileTemplateEngine, MailTemplateEngine } from "./templates/index";
export type {
  FileTemplateEngineOptions,
  MailTemplateOutput,
  MailTemplateRenderOptions,
} from "./interfaces/index";

// Transports
export { MailTransport } from "./transports/mail.transport";
export { SmtpTransport } from "./smtp/smtp.transport";
export { ResendTransport } from "./transports/resend.transport";
export { PostmarkTransport } from "./transports/postmark.transport";
export { SendGridTransport } from "./transports/sendgrid.transport";
export { SesTransport } from "./transports/ses.transport";
export { FileMailTransport } from "./transports/file.transport";
export { LogMailTransport } from "./transports/log.transport";
export type {
  AwsCredentials,
  DkimKeyObjectLike,
  DkimOptions,
  DkimPrivateKeyInput,
  FileMailTransportOptions,
  LogMailTransportOptions,
  MailTransportResult,
  MailTransportSendOptions,
  PostmarkTransportOptions,
  ResendTransportOptions,
  SendGridTransportOptions,
  SesTransportOptions,
  SmtpPoolOptions,
  SmtpTlsOptions,
  SmtpTransportOptions,
  TlsVersion,
} from "./interfaces/index";

// Testing
export { InMemoryMailTransport } from "./transports/in-memory.transport";
export { SentMail } from "./transports/sent-mail";
export type { SentMailQuery } from "./interfaces/index";

// Events
export { MailEvents } from "./events/index";
export type { MailEvent, MailFailedEvent, MailSentEvent } from "./events/index";

// Errors
export * from "./errors/index";
