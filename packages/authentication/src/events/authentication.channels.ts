import { channel, type Channel } from "node:diagnostics_channel";
import type { AuthenticationEvent } from "./authentication-events.interface";

const EVENT_TYPES: readonly AuthenticationEvent["type"][] = [
  "sign-in",
  "sign-out",
  "mfa-enabled",
  "mfa-disabled",
  "mfa-verified",
  "mfa-failed",
  "recovery-codes-generated",
  "refresh-token-reused",
  "password-reset-requested",
  "password-reset",
  "email-verified",
  "magic-link-refused",
  "session-touch-failed",
];

// Eagerly hold strong references to all channels so Bun's WeakRef-backed
// `node:diagnostics_channel` never drops early `subscribe()` listeners on GC.
const channels = new Map<AuthenticationEvent["type"], Channel>(
  EVENT_TYPES.map((type) => [type, channel(`nestjs:authentication:${type}`)]),
);

/** `nestjs:authentication:<type>`, one `node:diagnostics_channel` channel per event. */
export function channelFor(type: AuthenticationEvent["type"]): Channel {
  let found = channels.get(type);
  if (!found) {
    found = channel(`nestjs:authentication:${type}`);
    channels.set(type, found);
  }
  return found;
}
