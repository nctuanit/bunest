import { createHmac } from "node:crypto";
import type {
  WebhookSignatureCheck,
  WebhookSignedRequest,
} from "../interfaces/webhook-signature.interface";
import {
  HEX_SHA256,
  header,
  malformed,
  missing,
  NO_MATCH,
  TIMESTAMP,
} from "./signature.util";
import { WebhookSignatureScheme } from "./webhook-signature.scheme";

/** Stripe: `t=…,v1=…[,v1=…]`, hex HMAC-SHA256 of `t.body` keyed with the secret's text. */
export class StripeScheme extends WebhookSignatureScheme {
  private readonly headerName: string;

  constructor(headerName = "stripe-signature") {
    super();
    this.headerName = headerName;
  }

  override verify(
    { headers, rawBody }: WebhookSignedRequest,
    keys: readonly Buffer[],
  ): WebhookSignatureCheck {
    const value = header(headers, this.headerName);
    if (value === undefined) {
      return missing(this.headerName);
    }
    if (value === null) {
      return malformed(`${this.headerName} is repeated`);
    }

    let timestamp: string | undefined;
    const candidates: Buffer[] = [];
    for (const item of value.split(",")) {
      const at = item.indexOf("=");
      if (at < 0) {
        continue;
      }
      const name = item.slice(0, at).trim();
      const part = item.slice(at + 1).trim();
      if (name === "t") {
        if (timestamp !== undefined) {
          return malformed(`${this.headerName} has two timestamps`);
        }
        timestamp = part;
      } else if (name === "v1" && HEX_SHA256.test(part)) {
        candidates.push(Buffer.from(part, "hex"));
      }
    }

    if (timestamp === undefined || !TIMESTAMP.test(timestamp)) {
      return malformed(`${this.headerName} has no valid t=`);
    }
    if (candidates.length === 0) {
      return {
        valid: false,
        reason: "invalid-signature",
        detail: `no v1 signature in ${this.headerName}`,
      };
    }

    for (const key of keys) {
      const expected = createHmac("sha256", key)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest();
      if (WebhookSignatureScheme.matches(expected, candidates)) {
        return { valid: true, timestamp: Number(timestamp) };
      }
    }
    return NO_MATCH;
  }

  override idFromPayload(payload: unknown): string | undefined {
    const id = (payload as { id?: unknown } | null | undefined)?.id;
    return typeof id === "string" ? id : undefined;
  }
}
