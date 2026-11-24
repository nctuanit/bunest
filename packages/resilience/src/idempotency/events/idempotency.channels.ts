import { channel, type DiagnosticChannel } from "@bunest/core";

export const channels: Record<
  "replayed" | "rejected" | "lock-lost",
  DiagnosticChannel
> = {
  replayed: channel("nestjs:idempotency:replayed"),
  rejected: channel("nestjs:idempotency:rejected"),
  "lock-lost": channel("nestjs:idempotency:lock-lost"),
};
