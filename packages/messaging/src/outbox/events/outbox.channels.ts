import { channel, type DiagnosticChannel } from "@bunest/core";
import type { OutboxEvent } from "./outbox-events.interface";

export const channels: Record<OutboxEvent["type"], DiagnosticChannel> = {
  published: channel("nestjs:outbox:published"),
  "retry-scheduled": channel("nestjs:outbox:retry-scheduled"),
  "dead-lettered": channel("nestjs:outbox:dead-lettered"),
  "lease-lost": channel("nestjs:outbox:lease-lost"),
};
