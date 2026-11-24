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
} from "./signature.util";
import { WebhookSignatureScheme } from "./webhook-signature.scheme";

/**
 * GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>`. No timestamp and no
 * signed id: a captured request verifies forever, and the id it returns, `X-GitHub-Delivery`,
 * is whatever the sender (or someone replaying the request) puts in that header.
 */
export class GitHubScheme extends WebhookSignatureScheme {
  override verify(
    { headers, rawBody }: WebhookSignedRequest,
    keys: readonly Buffer[],
  ): WebhookSignatureCheck {
    const value = header(headers, "x-hub-signature-256");
    if (value === undefined) {
      return missing("x-hub-signature-256");
    }
    if (value === null) {
      return malformed("x-hub-signature-256 is repeated");
    }
    const hex = value.startsWith("sha256=") ? value.slice(7) : "";
    if (!HEX_SHA256.test(hex)) {
      return malformed("x-hub-signature-256 is not sha256=<64 hex digits>");
    }

    const candidate = [Buffer.from(hex, "hex")];
    const delivery = header(headers, "x-github-delivery");
    for (const key of keys) {
      const digest = new Bun.CryptoHasher("sha256", key)
        .update(rawBody)
        .digest();
      const expected = Buffer.from(
        digest.buffer,
        digest.byteOffset,
        digest.byteLength,
      );
      if (WebhookSignatureScheme.matches(expected, candidate)) {
        return {
          valid: true,
          id:
            typeof delivery === "string" && delivery !== ""
              ? delivery
              : undefined,
        };
      }
    }
    return NO_MATCH;
  }
}
