import type {
  WebhookSignatureCheck,
  WebhookSignedRequest,
} from "../interfaces/webhook-signature.interface";
import {
  exceedsInboxKey,
  MAX_INBOX_KEY_LENGTH,
} from "../utils/inbox-keys.util";
import { standardSecretKey } from "./secrets.util";
import {
  header,
  malformed,
  missing,
  NO_MATCH,
  TIMESTAMP,
} from "./signature.util";
import { WebhookSignatureScheme } from "./webhook-signature.scheme";

/** Standard Webhooks: base64 HMAC-SHA256 of `id.timestamp.body`, space-separated `v1,` signatures. */
export function signStandard(
  key: Buffer,
  id: string,
  timestamp: number,
  body: string | Buffer,
): string {
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(`${id}.${timestamp}.`);
  hasher.update(body);
  const digest = hasher.digest();
  return Buffer.from(
    digest.buffer,
    digest.byteOffset,
    digest.byteLength,
  ).toString("base64");
}

export class StandardWebhooksScheme extends WebhookSignatureScheme {
  override key(secret: string): Buffer {
    return standardSecretKey(secret);
  }

  override verify(
    { headers, rawBody }: WebhookSignedRequest,
    keys: readonly Buffer[],
  ): WebhookSignatureCheck {
    const id = header(headers, "webhook-id");
    const timestamp = header(headers, "webhook-timestamp");
    const signature = header(headers, "webhook-signature");

    if (id === undefined) {
      return missing("webhook-id");
    }
    if (timestamp === undefined) {
      return missing("webhook-timestamp");
    }
    if (signature === undefined) {
      return missing("webhook-signature");
    }
    if (id === null || timestamp === null || signature === null) {
      return malformed("a webhook- header is repeated");
    }
    if (id === "" || exceedsInboxKey(id)) {
      return malformed(
        `webhook-id is empty or longer than ${MAX_INBOX_KEY_LENGTH} characters`,
      );
    }
    if (!TIMESTAMP.test(timestamp)) {
      return malformed("webhook-timestamp is not a number of seconds");
    }

    const candidates = signature
      .split(" ")
      .filter((entry) => entry.startsWith("v1,"))
      .map((entry) => Buffer.from(entry.slice(3), "base64"));

    if (candidates.length === 0) {
      return { ...NO_MATCH, detail: "no v1 signature in webhook-signature" };
    }

    for (const key of keys) {
      const hasher = new Bun.CryptoHasher("sha256", key);
      hasher.update(`${id}.${timestamp}.`);
      hasher.update(rawBody);
      const digest = hasher.digest();
      const expected = Buffer.from(
        digest.buffer,
        digest.byteOffset,
        digest.byteLength,
      );
      if (WebhookSignatureScheme.matches(expected, candidates)) {
        return { valid: true, id, timestamp: Number(timestamp) };
      }
    }
    return NO_MATCH;
  }
}
