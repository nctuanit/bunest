import { MailMessageError } from "../errors/mail-message.error";
import { MailProviderError } from "../errors/mail-provider.error";
import type {
  MailTransportResult,
  MailTransportSendOptions,
} from "../interfaces/mail-transport.interface";
import type { ResendTransportOptions } from "../interfaces/provider-transport-options.interface";
import type { MailMessage } from "../message/mail-message";
import {
  checkBaseUrl,
  field,
  formatAddress,
  HttpProviderTransport,
  type ProviderResponse,
} from "./http-provider.transport";

export { checkBaseUrl };

/**
 * Resend's `POST /emails`. An `idempotencyKey` is sent as the `Idempotency-Key` header
 * (Resend keeps it for 24 hours), so a redelivered mail isn't sent twice. Inline images
 * go as attachments with `content_id`.
 */
export class ResendTransport extends HttpProviderTransport {
  #apiKey: string;
  private readonly url: string;

  constructor(options: ResendTransportOptions) {
    super("Resend", options);
    if (typeof options?.apiKey !== "string" || !options.apiKey) {
      throw new TypeError("ResendTransport `apiKey` is required");
    }
    this.#apiKey = options.apiKey;
    this.url = `${checkBaseUrl(options.baseUrl ?? "https://api.resend.com", "ResendTransport")}/emails`;
  }

  override async send(
    message: MailMessage,
    { signal, idempotencyKey }: MailTransportSendOptions,
  ): Promise<MailTransportResult> {
    if (!message.to.length) {
      throw new MailMessageError(
        "to",
        "is required by Resend (cc or bcc alone is not enough)",
      );
    }
    const body = {
      from: formatAddress(message.from),
      to: message.to.map(formatAddress),
      ...(message.cc.length && { cc: message.cc.map(formatAddress) }),
      ...(message.bcc.length && { bcc: message.bcc.map(formatAddress) }),
      ...(message.replyTo.length && {
        reply_to: message.replyTo.map(formatAddress),
      }),
      subject: message.subject,
      ...(message.html !== undefined && { html: message.html }),
      // An empty string stops Resend from deriving a text part of its own
      text: message.text ?? "",
      ...(Object.keys(message.headers).length && { headers: message.headers }),
      ...(message.attachments.length && {
        attachments: message.attachments.map((a) => ({
          filename: a.filename ?? a.cid,
          content: a.content.toString("base64"),
          content_type: a.contentType,
          ...(a.cid && { content_id: a.cid }),
        })),
      }),
    };
    const response = await this.request(
      this.url,
      {
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          "user-agent": "nestjs-mail",
          ...(idempotencyKey !== undefined && {
            "idempotency-key": providerKey(idempotencyKey),
          }),
        },
        body: JSON.stringify(body),
      },
      signal,
    );
    return {
      accepted: message.envelope.to,
      providerMessageId: field(response.body, "id"),
    };
  }

  protected override toError({
    status,
    body,
    retryAfterMs,
  }: ProviderResponse): MailProviderError {
    const name = field(body, "name");
    // A concurrent request with the same key is still running: try again later. The same
    // key with a different body is a mistake that won't go away.
    const permanent =
      name === "concurrent_idempotent_requests"
        ? false
        : name === "invalid_idempotent_request"
          ? true
          : undefined;
    return new MailProviderError({
      provider: "resend",
      status,
      providerCode: name,
      detail:
        field(body, "message") ?? (typeof body === "string" ? body : undefined),
      ...(permanent !== undefined && { permanent }),
      retryAfterMs,
    });
  }
}

/** Resend accepts keys of 1-256 characters; a longer one is hashed to fit. */
export function providerKey(key: string): string {
  return key.length <= 256
    ? key
    : new Bun.CryptoHasher("sha256").update(key).digest("hex");
}
