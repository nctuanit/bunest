import { channel, type DiagnosticChannel } from "@bunest/core";
import type { LocksEvent } from "./locks-events.interface";

/** The `nestjs:locks:<type>` diagnostics channels, one per event type. */
export const channels: Record<LocksEvent["type"], DiagnosticChannel> = {
  "lock-lost": channel("nestjs:locks:lock-lost"),
  "leadership-acquired": channel("nestjs:locks:leadership-acquired"),
  "leadership-lost": channel("nestjs:locks:leadership-lost"),
};

/**
 * `nestjs:locks:job-skipped`, for `LocksJobSkippedEvent`. Its subscribers run on every skipped
 * tick and must not throw: Node/Bun rethrows their error on the next tick.
 */
export const jobSkippedChannel: DiagnosticChannel = channel(
  "nestjs:locks:job-skipped",
);
