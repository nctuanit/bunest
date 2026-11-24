import type { ExecutionContext } from "@bunest/core";
import type { IncomingWebhook } from "../interfaces/incoming-webhook.interface";
import type { ReceivedWebhookRequest } from "../interfaces/received-webhook-request.interface";
import { DEDUPED, VERIFIED } from "../webhooks.constants";

const verifiedMap = new WeakMap<object, IncomingWebhook>();
const dedupedSet = new WeakSet<object>();

export function setVerifiedWebhook(
  request: object,
  webhook: IncomingWebhook,
): void {
  verifiedMap.set(request, webhook);
  try {
    (request as ReceivedWebhookRequest)[VERIFIED] = webhook;
  } catch {
    // Non-extensible / frozen request object: WeakMap still holds the verified webhook.
  }
}

export function getVerifiedWebhook(
  request: unknown,
): IncomingWebhook | undefined {
  if (request === null || typeof request !== "object") {
    return undefined;
  }
  return (
    (request as ReceivedWebhookRequest)[VERIFIED] ?? verifiedMap.get(request)
  );
}

export function markDedupedWebhook(request: object): void {
  dedupedSet.add(request);
  try {
    (request as ReceivedWebhookRequest)[DEDUPED] = true;
  } catch {
    // Non-extensible / frozen request object: WeakSet still marks it.
  }
}

export function isDedupedWebhook(request: unknown): boolean {
  if (request === null || typeof request !== "object") {
    return false;
  }
  return (
    Boolean((request as ReceivedWebhookRequest)[DEDUPED]) ||
    dedupedSet.has(request)
  );
}

export function incoming(context: ExecutionContext): IncomingWebhook {
  const request = context.switchToHttp().getRequest();
  const webhook = getVerifiedWebhook(request);
  if (!webhook) {
    throw new Error(
      "@WebhookPayload() and @IncomingWebhook() need @VerifyWebhook(receiver) on the route or its controller",
    );
  }
  return webhook;
}
