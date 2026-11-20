import { channel, type Channel } from "node:diagnostics_channel";

export const channels: Record<"replayed" | "rejected" | "lock-lost", Channel> =
  {
    replayed: channel("nestjs:idempotency:replayed"),
    rejected: channel("nestjs:idempotency:rejected"),
    "lock-lost": channel("nestjs:idempotency:lock-lost"),
  };
