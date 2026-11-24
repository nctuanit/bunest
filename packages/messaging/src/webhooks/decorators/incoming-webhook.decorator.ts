import { createParamDecorator } from "@bunest/core";
import type { IncomingWebhook as IncomingWebhookData } from "../interfaces/incoming-webhook.interface";
import { incoming } from "../utils/verified-webhook.util";

/** The whole verified webhook: `id`, `timestamp`, `payload`, `rawBody`, `processInTransaction()`. */
export const IncomingWebhook: (
  ...dataOrPipes: unknown[]
) => ParameterDecorator = createParamDecorator((_data, context) =>
  incoming(context),
) as (...dataOrPipes: unknown[]) => ParameterDecorator;

export type IncomingWebhook<T = unknown> = IncomingWebhookData<T>;
