import { describe, expect, it } from "bun:test";
import { InMemoryWebhookStore, WebhooksStorage } from "../../src/webhooks/index";
import {
  webhookDeliveryStoreContract,
  webhookEndpointStoreContract,
} from "../../src/webhooks/testing/index";
import { LOCK_STORAGE, STORAGE_USED } from "../../src/webhooks/webhooks.constants";

describe("InMemoryWebhookStore — webhookEndpointStoreContract (concurrent)", () => {
  const cases = webhookEndpointStoreContract(
    () => ({ store: new InMemoryWebhookStore() }),
    { concurrent: true },
  );
  for (const testCase of cases) {
    it(testCase.name, () => testCase.run());
  }
});

describe("InMemoryWebhookStore — webhookDeliveryStoreContract (concurrent)", () => {
  const cases = webhookDeliveryStoreContract(
    () => ({ store: new InMemoryWebhookStore() }),
    { concurrent: true },
  );
  for (const testCase of cases) {
    it(testCase.name, () => testCase.run());
  }
});

describe("WebhooksStorage", () => {
  it("falls back to InMemoryWebhookStore when no source is registered", () => {
    const storage = new WebhooksStorage();
    expect(storage.endpoints).toBeInstanceOf(InMemoryWebhookStore);
    expect(storage.deliveries as unknown).toBe(storage.endpoints as unknown);
  });

  it("registers sources by contract and supports replace option", () => {
    const storage = new WebhooksStorage();
    const first = new InMemoryWebhookStore();
    const second = new InMemoryWebhookStore();

    storage.registerSource({ endpoints: first, deliveries: first });
    expect(() => storage.registerSource({ endpoints: second })).toThrow(
      /already did/,
    );

    storage.registerSource({ endpoints: second }, { replace: true });
    expect(storage.endpoints).toBe(second);
    expect(storage.deliveries).toBe(first);
  });

  it("rejects invalid registerSource arguments and late registration after lock", () => {
    const storage = new WebhooksStorage();
    const store = new InMemoryWebhookStore();

    expect(() => storage.registerSource(null as any)).toThrow(TypeError);
    expect(() => storage.registerSource(store as any)).toThrow(
      /registerSource\(\{ endpoints: this, deliveries: this \}\)/,
    );
    expect(() => storage.registerSource({})).toThrow(TypeError);
    expect(() => storage.registerSource({ unknown: store } as any)).toThrow(
      /unknown contract/,
    );
    expect(() =>
      storage.registerSource({ endpoints: { getEndpoint() {} } as any }),
    ).toThrow(/doesn't implement WebhookEndpointStore/);

    // Lock by reading
    void storage.endpoints;
    expect(() =>
      storage.registerSource({ deliveries: store }, { replace: true }),
    ).toThrow(/registered after WebhooksModule initialized/);
  });

  it("enforces NODE_ENV=production guard unless allowInMemoryStorage is set or outgoing is false", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const strict = new WebhooksStorage({});
      expect(() => strict[LOCK_STORAGE]()).toThrow(/NODE_ENV is "production"/);

      const allowed = new WebhooksStorage({ allowInMemoryStorage: true });
      expect(() => allowed[LOCK_STORAGE]()).not.toThrow();
      expect(allowed.endpoints).toBeInstanceOf(InMemoryWebhookStore);

      const receiveOnly = new WebhooksStorage({});
      receiveOnly[STORAGE_USED] = false;
      expect(() => receiveOnly[LOCK_STORAGE]()).not.toThrow();
      // Reading an unused contract in production still refuses in-memory
      expect(() => receiveOnly.endpoints).toThrow(/NODE_ENV is "production"/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
