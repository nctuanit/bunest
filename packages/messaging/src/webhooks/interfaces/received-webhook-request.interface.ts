import type { DEDUPED, VERIFIED } from "../webhooks.constants";
import type { IncomingWebhook as IncomingWebhookData } from "./incoming-webhook.interface";

export type ReceivedWebhookRequest = {
  headers: Record<string, string | string[] | undefined> | Headers;
  rawBody?: unknown;
  [VERIFIED]?: IncomingWebhookData;
  [DEDUPED]?: boolean;
};
