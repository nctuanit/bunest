import { describe, expect, it } from "bun:test";
import { Injectable, subscribe, unsubscribe } from "@bunest/core";
import { OutboxModule, OutboxRelay } from "../../src/outbox/index";
import { Test } from "@bunest/testing";
import {
  InMemoryWebhookTransport,
  InvalidWebhookEndpointError,
  NonRetryableWebhookError,
  WebhookDeliveries,
  WebhookDeliveryNotFoundError,
  WebhookDeliveryTimeoutError,
  WebhookDestinationBlockedError,
  WebhookEndpointNotFoundError,
  WebhookEndpoints,
  WebhookTransport,
  WebhookWorker,
  Webhooks,
  WebhooksEvents,
  WebhooksModule,
  WebhooksStorage,
  type WebhookRequest,
  type WebhookTransportResponse,
  type WebhookTransportSendOptions,
  type WebhooksEvent,
  type WebhooksModuleOptions,
  type WebhooksOptionsFactory,
} from "../../src/webhooks/index";
import { SecretCipher, plaintextSecrets } from "../../src/webhooks/utils/encryption.util";
import { computeBackoff, parseRetryAfter } from "../../src/webhooks/utils/backoff.util";

describe("Outbound webhooks E2E (dispatch -> fan-out -> worker -> retries -> events)", () => {
  it("dispatches via Outbox, fans out to matching tenant endpoints, signs with rotating secrets, and logs attempts", async () => {
    const transport = new InMemoryWebhookTransport();
    const encKey1 = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const encKey2 = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

    const mod = await Test.createTestingModule({
      imports: [
        OutboxModule.forRoot({ relay: { enabled: false } }),
        WebhooksModule.forRoot({
          eventTypes: ["order.shipped", "order.cancelled"],
          transport,
          worker: { enabled: false },
          encryption: { keys: [encKey2, encKey1] },
          retry: {
            attempts: 3,
            backoff: { delay: 10, factor: 2, jitter: "none" },
          },
        }),
      ],
    }).compile();

    await mod.init();
    try {
      const webhooks = mod.get(Webhooks);
      const endpoints = mod.get(WebhookEndpoints);
      const deliveries = mod.get(WebhookDeliveries);
      const worker = mod.get(WebhookWorker);
      const relay = mod.get(OutboxRelay);
      const storage = mod.get(WebhooksStorage);
      const events = mod.get(WebhooksEvents);

      const ep = await endpoints.create({
        url: "https://hooks.example.com/orders",
        eventTypes: ["order.shipped"],
        tenant: "tenant-a",
        description: "Orders hook",
      });
      expect(ep.id.startsWith("ep_")).toBe(true);
      expect(ep.secret.startsWith("whsec_")).toBe(true);
      expect(ep.enabled).toBe(true);

      // Stored secret is AES-256-GCM sealed at rest
      const storedRecord = await storage.endpoints.getEndpoint(ep.id);
      expect(storedRecord?.secrets[0]?.secret.startsWith("sealed.v1.")).toBe(
        true,
      );
      expect(await endpoints.getSecret(ep.id, { tenant: "tenant-a" })).toBe(
        ep.secret,
      );
      // Wrong tenant gets 404
      expect(
        await endpoints.get(ep.id, { tenant: "tenant-b" }),
      ).toBeUndefined();
      await expect(
        endpoints.getSecret(ep.id, { tenant: "tenant-b" }),
      ).rejects.toThrow(WebhookEndpointNotFoundError);

      // Rotate secret with overlap: both old and new secrets sign
      const rotatedSecret = await endpoints.rotateSecret(ep.id, {
        tenant: "tenant-a",
        overlap: "1h",
      });
      expect(rotatedSecret).not.toBe(ep.secret);

      // Collect events via both .subscribe() and async iterator (ADR-008 zero-RxJS)
      const subEvents: WebhooksEvent[] = [];
      const diagDelivered: unknown[] = [];
      const sub = events.events$.subscribe((e) => subEvents.push(e));
      const diagFn = (m: unknown) => diagDelivered.push(m);
      subscribe("nestjs:webhooks:delivered", diagFn);

      const iterEvents: WebhooksEvent[] = [];
      const iterDone = (async () => {
        for await (const ev of events.events$) {
          iterEvents.push(ev);
          if (iterEvents.length === 1) break;
        }
      })();

      // Dispatch inside a transaction
      const msg = await webhooks.dispatch(
        {},
        {
          type: "order.shipped",
          tenant: "tenant-a",
          data: { orderId: "ord_77" },
        },
      );
      expect(msg.id.startsWith("msg_")).toBe(true);

      // Fan-out via OutboxRelay, then deliver via WebhookWorker
      await relay.runOnce();
      const runResult = await worker.runOnce();
      expect(runResult.claimed).toBe(1);
      expect(runResult.delivered).toBe(1);
      expect(runResult.failed).toBe(0);

      const sent = transport.single({ type: "order.shipped" });
      expect(sent.url).toBe("https://hooks.example.com/orders");
      expect(sent.messageId).toBe(msg.id);
      expect(sent.data).toEqual({ orderId: "ord_77" });
      // Signed with BOTH old and new secrets during rotation overlap
      expect(sent.isSignedWith(rotatedSecret)).toBe(true);
      expect(sent.isSignedWith(ep.secret)).toBe(true);

      await iterDone;
      sub.unsubscribe();
      unsubscribe("nestjs:webhooks:delivered", diagFn);

      expect(subEvents.length).toBe(1);
      expect(subEvents[0]?.type).toBe("delivered");
      expect(iterEvents.length).toBe(1);
      expect(diagDelivered.length).toBe(1);

      // Delivery log & details
      const listed = await deliveries.list({ tenant: "tenant-a" });
      expect(listed.length).toBe(1);
      const details = await deliveries.get(listed[0]!.id, {
        tenant: "tenant-a",
      });
      expect(details?.status).toBe("succeeded");
      expect(details?.history.length).toBe(1);
      expect(details?.history[0]?.statusCode).toBe(200);
      expect(details?.message.id).toBe(msg.id);

      // Manual replay of a succeeded delivery
      const replayed = await deliveries.retry(listed[0]!.id, {
        tenant: "tenant-a",
      });
      expect(replayed).toBe(1);
      await worker.runOnce();
      expect(transport.filter({ messageId: msg.id }).length).toBe(2);

      // Invalid event type rejected
      expect(() =>
        webhooks.dispatch({}, { type: "unknown.event", data: {} }),
      ).toThrow(/not in the eventTypes option/);

      await expect(
        endpoints.create({
          url: "http://hooks.example.com/insecure",
          eventTypes: ["order.shipped"],
        }),
      ).rejects.toThrow(InvalidWebhookEndpointError);
      await expect(deliveries.retry("dlv_missing")).rejects.toThrow(
        WebhookDeliveryNotFoundError,
      );
    } finally {
      await mod.close();
    }
  });

  it("handles retries, 429 throttling, 410 Gone auto-disable, timeout, destination blocked, and NonRetryableWebhookError", async () => {
    const transport = new InMemoryWebhookTransport();
    const mod = await Test.createTestingModule({
      imports: [
        OutboxModule.forRoot({ relay: { enabled: false } }),
        WebhooksModule.forRoot({
          transport,
          worker: { enabled: false },
          delivery: { timeout: 60 },
          retry: {
            attempts: 2,
            backoff: { delay: 0, factor: 1, jitter: "none" },
          },
        }),
      ],
    }).compile();

    await mod.init();
    try {
      const webhooks = mod.get(Webhooks);
      const endpoints = mod.get(WebhookEndpoints);
      const deliveries = mod.get(WebhookDeliveries);
      const worker = mod.get(WebhookWorker);
      const relay = mod.get(OutboxRelay);
      const events = mod.get(WebhooksEvents);

      const seen: WebhooksEvent[] = [];
      const sub = events.events$.subscribe((e) => seen.push(e));

      const ep = await endpoints.create({
        url: "https://hooks.example.com/flaky",
        eventTypes: ["*"],
      });

      // 1. 500 -> retry-scheduled -> 500 -> exhausted
      transport.respondWith(500);
      await webhooks.dispatch({}, { type: "job.failed", data: { n: 1 } });
      await relay.runOnce();
      const r1 = await worker.runOnce();
      expect(r1.retried).toBe(1);
      const r2 = await worker.runOnce();
      expect(r2.failed).toBe(1);
      expect(seen.map((e) => e.type)).toEqual([
        "retry-scheduled",
        "delivery-failed",
      ]);

      // 2. NonRetryableWebhookError fails immediately without retry
      transport.respondWith(() => {
        throw new NonRetryableWebhookError("permanent rejection");
      });
      await webhooks.dispatch({}, { type: "job.nr", data: { n: 2 } });
      await relay.runOnce();
      const r3 = await worker.runOnce();
      expect(r3.failed).toBe(1);

      // 3. Timeout aborts slow transport
      transport.respondWith(
        () =>
          new Promise(() => {
            // Never resolves
          }),
      );
      await webhooks.dispatch({}, { type: "job.timeout", data: { n: 3 } });
      await relay.runOnce();
      const r4 = await worker.runOnce();
      expect(r4.retried).toBe(1);
      const timeoutEvent = seen.at(-1);
      expect(timeoutEvent?.type).toBe("retry-scheduled");
      if (timeoutEvent?.type === "retry-scheduled") {
        expect(timeoutEvent.error).toBeInstanceOf(WebhookDeliveryTimeoutError);
      }
      // Exhaust the retried timeout delivery before moving to step 4
      transport.respondWith(200);
      await worker.runOnce();

      // 4. Destination blocked emits destination-blocked and fails without retry
      transport.respondWith((req) => {
        throw new WebhookDestinationBlockedError(
          req.url,
          "loopback",
          "127.0.0.1",
        );
      });
      await webhooks.dispatch({}, { type: "job.ssrf", data: { n: 4 } });
      await relay.runOnce();
      const r5 = await worker.runOnce();
      expect(r5.failed).toBe(1);
      expect(seen.some((e) => e.type === "destination-blocked")).toBe(true);

      // 5. 410 Gone immediately disables endpoint and rejects delivery
      transport.respondWith(410);
      await webhooks.dispatch({}, { type: "job.gone", data: { n: 5 } });
      await relay.runOnce();
      const r6 = await worker.runOnce();
      expect(r6.failed).toBe(1);
      const disabledEp = await endpoints.get(ep.id);
      expect(disabledEp?.enabled).toBe(false);
      expect(disabledEp?.disabledReason).toBe("gone");
      expect(
        seen.some((e) => e.type === "endpoint-disabled" && e.reason === "gone"),
      ).toBe(true);

      // Re-enable and verify 429 throttling pauses remaining deliveries in same batch
      await endpoints.update(ep.id, { enabled: true });
      transport.respondWith({
        statusCode: 429,
        headers: { "retry-after": "30" },
      });
      await webhooks.dispatch({}, [
        { type: "job.batch", data: { i: 1 } },
        { type: "job.batch", data: { i: 2 } },
      ]);
      await relay.runOnce();
      const r7 = await worker.runOnce();
      expect(r7.retried).toBe(1);
      expect(r7.released).toBe(1);

      // Stats & prune
      const stats = await deliveries.stats();
      expect(stats.failed).toBeGreaterThanOrEqual(4);
      const pruned = await deliveries.prune(0);
      expect(pruned).toBeGreaterThanOrEqual(0);

      sub.unsubscribe();
    } finally {
      await mod.close();
    }
  });

  it("supports WebhooksModule.forRootAsync() with useClass and custom DI transport class", async () => {
    @Injectable()
    class CustomDiTransport extends WebhookTransport {
      readonly requests: WebhookRequest[] = [];
      override async send(
        request: WebhookRequest,
        _options: WebhookTransportSendOptions,
      ): Promise<WebhookTransportResponse> {
        this.requests.push(request);
        return { statusCode: 202, headers: {}, body: "accepted" };
      }
    }

    @Injectable()
    class OptionsFactory implements WebhooksOptionsFactory {
      createWebhooksOptions(): WebhooksModuleOptions {
        return { worker: { enabled: false }, eventTypes: ["ping.sent"] };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        OutboxModule.forRoot({ relay: { enabled: false } }),
        WebhooksModule.forRootAsync({
          transport: CustomDiTransport,
          useClass: OptionsFactory,
        }),
      ],
    }).compile();

    await mod.init();
    try {
      const transport = mod.get(WebhookTransport) as CustomDiTransport;
      const endpoints = mod.get(WebhookEndpoints);
      const webhooks = mod.get(Webhooks);
      const relay = mod.get(OutboxRelay);
      const worker = mod.get(WebhookWorker);

      await endpoints.create({
        url: "https://hooks.example.com/async",
        eventTypes: ["ping.sent"],
      });
      await webhooks.dispatch({}, { type: "ping.sent", data: { ok: true } });
      await relay.runOnce();
      await worker.runOnce();

      expect(transport.requests.length).toBe(1);
      expect(transport.requests[0]?.type).toBe("ping.sent");
    } finally {
      await mod.close();
    }
  });
});

describe("SecretCipher & backoff utilities", () => {
  it("seals and opens secrets with AES-256-GCM AAD binding and key rotation", async () => {
    const keyA = "a".repeat(32);
    const keyB = "b".repeat(32);
    const cipher1 = new SecretCipher({ keys: [keyA] });
    const sealed = await cipher1.seal("ep_1", "whsec_secret_value");
    expect(sealed.startsWith("sealed.v1.")).toBe(true);
    expect(await cipher1.open("ep_1", sealed)).toBe("whsec_secret_value");

    // Wrong endpoint ID fails AAD authentication
    await expect(cipher1.open("ep_2", sealed)).rejects.toThrow(
      /failed authentication/,
    );

    // Plaintext secret opens cleanly with cipher, but sealed fails with plaintextSecrets
    expect(await cipher1.open("ep_1", "whsec_plain")).toBe("whsec_plain");
    expect(() => plaintextSecrets.open("ep_1", sealed)).toThrow(
      /no `encryption` keys/,
    );

    // Rotation: new key seals, old key still opens
    const cipher2 = new SecretCipher({ keys: [keyB, keyA] });
    expect(await cipher2.open("ep_1", sealed)).toBe("whsec_secret_value");
    const sealedNew = await cipher2.seal("ep_1", "whsec_rotated");
    expect(await cipher2.open("ep_1", sealedNew)).toBe("whsec_rotated");
    await expect(cipher1.open("ep_1", sealedNew)).rejects.toThrow(
      /unknown key/,
    );
  });

  it("computes backoff schedules and parses Retry-After headers", () => {
    const dummyDelivery = {} as any;
    expect(
      computeBackoff(
        { delay: 1000, factor: 2, maxDelay: 5000, jitter: "none" },
        1,
        null,
        dummyDelivery,
      ),
    ).toBe(1000);
    expect(
      computeBackoff(
        { delay: 1000, factor: 2, maxDelay: 5000, jitter: "none" },
        4,
        null,
        dummyDelivery,
      ),
    ).toBe(5000);
    expect(
      computeBackoff(
        { delay: 1000, factor: 2, maxDelay: 5000, jitter: "equal" },
        1,
        null,
        dummyDelivery,
        () => 0.5,
      ),
    ).toBe(750);
    expect(
      computeBackoff(
        { delay: 1000, factor: 2, maxDelay: 5000, jitter: "full" },
        1,
        null,
        dummyDelivery,
        () => 0.25,
      ),
    ).toBe(250);

    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    expect(parseRetryAfter("45", now)).toBe(45_000);
    expect(parseRetryAfter("Fri, 20 Nov 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
  });
});
