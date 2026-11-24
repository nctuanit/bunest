import type { AddressPolicy } from "../network/address.policy";
import type { WebhookSignatureScheme } from "../signing/webhook-signature.scheme";
import type { ResolvedRetry } from "../utils/backoff.util";
import type { SecretCodec } from "../utils/encryption.util";
import type { WebhookHeaders } from "./webhook-signature.interface";

export interface CompiledReceiver {
  name: string;
  scheme: WebhookSignatureScheme;
  keys: Buffer[];
  toleranceMs: number;
  dedupe: boolean;
  consumer: string;
  id?: (payload: unknown, headers: WebhookHeaders) => string;
}

export interface ResolvedWebhooksConfig {
  eventTypes: ReadonlySet<string> | null;
  retry: ResolvedRetry;
  timeoutMs: number;
  userAgent: string;
  /** Characters of a response kept in the attempt log, whatever the transport returned. */
  maxResponseSize: number;
  worker: {
    enabled: boolean;
    pollInterval: number;
    batchSize: number;
    concurrency: number;
    lease: number;
  };
  disableAfterMs: number | null;
  rotationOverlapMs: number;
  secrets: SecretCodec;
  addressPolicy: AddressPolicy;
  allowHttp: boolean;
  receivers: ReadonlyMap<string, CompiledReceiver>;
}
