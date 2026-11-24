// Module and options
export { WebhooksModule } from "./webhooks.module";
export { WEBHOOKS_MODULE_OPTIONS } from "./webhooks.module-definition";
export type {
  WebhookBackoffOptions,
  WebhookDeliveryOptions,
  WebhookEncryptionOptions,
  WebhookRetryOptions,
  WebhookWorkerOptions,
  WebhooksModuleAsyncOptions,
  WebhooksModuleOptions,
  WebhooksOptionsFactory,
} from "./interfaces/index";
export type { Duration } from "./interfaces/index";

// Sending: dispatch inside your transaction
export { Webhooks } from "./webhooks.service";
export { WEBHOOKS_OUTBOX_TOPIC } from "./webhooks.constants";
export type { NewWebhookMessage, WebhookMessage } from "./interfaces/index";

// Endpoints (subscriptions)
export { WebhookEndpoints } from "./services/index";
export type {
  CreateWebhookEndpoint,
  CreatedWebhookEndpoint,
  UpdateWebhookEndpoint,
  WebhookEndpoint,
  WebhookEndpointDisabledReason,
  WebhookTenantScope,
} from "./interfaces/index";

// Deliveries: the log, replay, the worker
export { WebhookDeliveries, WebhookWorker } from "./services/index";
export type {
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryDetails,
  WebhookDeliveryFailureReason,
  WebhookDeliveryFilter,
  WebhookDeliveryQuery,
  WebhookDeliveryStats,
  WebhookDeliveryStatus,
  WebhookWorkerRunResult,
} from "./interfaces/index";

// Receiving: verify, deduplicate, read the payload
export * from "./decorators/index";
export { WebhookVerifier } from "./services/index";
export { WebhookSignatureScheme } from "./signing/webhook-signature.scheme";
export type {
  CustomWebhookReceiverOptions,
  GitHubWebhookReceiverOptions,
  StandardWebhookReceiverOptions,
  StripeWebhookReceiverOptions,
  WebhookHeaders,
  WebhookReceiverOptions,
  WebhookSignatureCheck,
  WebhookSignedRequest,
  WebhookVerifyRequest,
} from "./interfaces/index";

// Transports: the SSRF-guarded default, your own, and the one for tests
export * from "./transports/index";
export { HttpWebhookTransport } from "./network/http.transport";
export type {
  HttpWebhookTransportOptions,
  InMemoryWebhookResponder,
  ResolvedAddress,
  SentWebhookQuery,
  WebhookRequest,
  WebhookTransportResponse,
  WebhookTransportSendOptions,
} from "./interfaces/index";

// Events
export {
  WebhooksEvents,
  type WebhooksDeliveredEvent,
  type WebhooksDeliveryFailedEvent,
  type WebhooksDestinationBlockedEvent,
  type WebhooksEndpointDisabledEvent,
  type WebhooksEvent,
  type WebhooksRetryScheduledEvent,
  type WebhooksVerificationFailedEvent,
} from "./events/index";

// Errors
export * from "./errors/index";

// Storage: implement WebhookEndpointStore and WebhookDeliveryStore in a provider and register it
export { WebhooksStorage } from "./storage/index";
export type {
  WebhookClaimRequest,
  WebhookClaimedDelivery,
  WebhookDeliveryStore,
  WebhookDeliveryStoreStats,
  WebhookDeliveryUpdate,
  WebhookEndpointFailure,
  WebhookEndpointPatch,
  WebhookEndpointQuery,
  WebhookEndpointRecord,
  WebhookEndpointSecret,
  WebhookEndpointStore,
  WebhooksStorageContract,
  WebhooksStorageRegisterOptions,
  WebhooksStorageSources,
} from "./interfaces/index";

// The default and test double.
export * from "./stores/index";
