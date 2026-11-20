import {
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  Injectable,
} from "@bunest/common";
import { WebhookVerifier } from "../services/webhook-verifier.service";
import {
  getVerifiedWebhook,
  isDedupedWebhook,
  markDedupedWebhook,
} from "../utils/verified-webhook.util";

/** Skips a webhook id the receiver already processed, and records it after the handler succeeds (`OutboxInbox.process()`). */
@Injectable()
export class WebhookInboxInterceptor implements BunestInterceptor {
  private readonly verifier: WebhookVerifier;

  constructor(verifier: WebhookVerifier) {
    this.verifier = verifier;
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const request = context.switchToHttp().getRequest<object>();
    const webhook = getVerifiedWebhook(request);
    const receiver = webhook && this.verifier.receiverConfig(webhook.receiver);
    // On the controller and the method: deduplicated once (a nested process() of the same id would wait for itself).
    if (!webhook || !receiver?.dedupe || isDedupedWebhook(request)) {
      return await next.handle();
    }
    markDedupedWebhook(request);
    const inbox = this.verifier.requireInbox();
    const result = await inbox.process(
      receiver.consumer,
      webhook.id,
      async () => await next.handle(),
    );
    return result.duplicate ? undefined : result.result;
  }
}
