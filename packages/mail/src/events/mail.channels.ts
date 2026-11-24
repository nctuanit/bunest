import { channel, type DiagnosticChannel } from "@bunest/core";
import type { MailEvent } from "./mail-events.interface";

/** The Bunest diagnostics channel of each mail event type. */
export const channels: Record<MailEvent["type"], DiagnosticChannel> = {
  sent: channel("nestjs:mail:sent"),
  failed: channel("nestjs:mail:failed"),
};
