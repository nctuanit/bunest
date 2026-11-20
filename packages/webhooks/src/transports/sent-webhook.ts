import type { WebhookRequest } from "../interfaces/webhook-transport.interface";
import { standardSecretKey } from "../signing/secrets.util";
import { signStandard } from "../signing/standard-webhooks.scheme";

/** A request the in-memory transport received. */
export class SentWebhook {
  readonly request: WebhookRequest;
  /** 1 for the first attempt of its round. */
  readonly attempt: number;
  readonly sentAt: Date;

  constructor(
    request: WebhookRequest,
    /** 1 for the first attempt of its round. */
    attempt: number,
    sentAt: Date,
  ) {
    this.request = request;
    this.attempt = attempt;
    this.sentAt = sentAt;
  }

  get url(): string {
    return this.request.url;
  }

  get type(): string {
    return this.request.type;
  }

  get messageId(): string {
    return this.request.messageId;
  }

  get endpointId(): string {
    return this.request.endpointId;
  }

  get deliveryId(): string {
    return this.request.deliveryId;
  }

  get headers(): Readonly<Record<string, string>> {
    return this.request.headers;
  }

  get body(): string {
    return this.request.body;
  }

  /** The body's `data`. */
  get data(): any {
    return JSON.parse(this.request.body).data;
  }

  /** Whether a `v1` signature in `webhook-signature` verifies with `secret` (an endpoint's `whsec_…`). */
  isSignedWith(secret: string): boolean {
    const id = this.headers["webhook-id"] ?? "";
    const timestamp = Number(this.headers["webhook-timestamp"]);
    const signature = this.headers["webhook-signature"] ?? "";
    const expected = signStandard(
      standardSecretKey(secret),
      id,
      timestamp,
      this.body,
    );
    return signature.split(" ").includes(`v1,${expected}`);
  }
}
