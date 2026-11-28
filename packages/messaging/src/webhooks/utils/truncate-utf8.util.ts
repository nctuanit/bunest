import { truncateUtf8 as coreTruncateUtf8 } from "@bunest/core/common";

/** The longest prefix of `text` that is at most `maxBytes` in UTF-8, never splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  return coreTruncateUtf8(text, maxBytes, "");
}
