import { channel, type DiagnosticChannel } from "@bunest/core";
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

const channels = new Map<AuthenticationEvent["type"], DiagnosticChannel>(
  EVENT_TYPES.map((type) => [type, channel(`nestjs:authentication:${type}`)]),
);

/** `nestjs:authentication:<type>`, one Bunest diagnostics channel per event. */
export function channelFor(type: AuthenticationEvent["type"]): DiagnosticChannel {
  let found = channels.get(type);
  if (!found) {
    found = channel(`nestjs:authentication:${type}`);
    channels.set(type, found);
  }
  return found;
}
