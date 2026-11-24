import { describe, it } from "bun:test";
import { InMemoryOutboxStore } from "../../src/outbox/index";
import {
  outboxInboxStoreContract,
  outboxStoreContract,
} from "../../src/outbox/testing/index";

describe("InMemoryOutboxStore — outboxStoreContract (concurrent)", () => {
  const harness = () => {
    const store = new InMemoryOutboxStore();
    return {
      store,
      transaction: <T>(work: (tx: unknown) => Promise<T>) =>
        store.transaction(work),
    };
  };

  for (const c of outboxStoreContract(harness, { concurrent: true })) {
    it(c.name, c.run);
  }
});

describe("InMemoryOutboxStore — outboxInboxStoreContract (concurrent)", () => {
  const harness = () => {
    const store = new InMemoryOutboxStore();
    return {
      store,
      transaction: <T>(work: (tx: unknown) => Promise<T>) =>
        store.transaction(work),
    };
  };

  for (const c of outboxInboxStoreContract(harness, { concurrent: true })) {
    it(c.name, c.run);
  }
});
