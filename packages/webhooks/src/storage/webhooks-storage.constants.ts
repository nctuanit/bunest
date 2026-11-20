/** The methods `WebhooksStorage.registerSource()` checks for, per contract (internal). */
export const WEBHOOK_ENDPOINT_STORE_METHODS = [
  "createEndpoint",
  "getEndpoint",
  "listEndpoints",
  "findSubscribedEndpoints",
  "updateEndpoint",
  "deleteEndpoint",
  "addEndpointSecret",
  "recordEndpointFailure",
  "recordEndpointSuccess",
] as const;

export const WEBHOOK_DELIVERY_STORE_METHODS = [
  "createDeliveries",
  "claimDeliveries",
  "recordDeliveryAttempt",
  "releaseDeliveries",
  "getDelivery",
  "getMessage",
  "listDeliveries",
  "listDeliveryAttempts",
  "retryDeliveries",
  "deliveryStats",
  "pruneDeliveries",
] as const;
