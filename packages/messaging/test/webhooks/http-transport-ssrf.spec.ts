import { describe, expect, it } from "bun:test";
import { OutboxModule, OutboxRelay } from "../../src/outbox/index";
import { Test } from "@bunest/testing";
import {
  HttpWebhookTransport,
  WebhookDestinationBlockedError,
  WebhookEndpoints,
  WebhookVerifier,
  WebhookWorker,
  Webhooks,
  WebhooksModule,
  type WebhookRequest,
} from "../../src/webhooks/index";
import { AddressPolicy } from "../../src/webhooks/network/address.policy";

function makeRequest(url: string, body = '{"ok":true}'): WebhookRequest {
  return {
    url,
    headers: {
      "content-type": "application/json",
      "user-agent": "NestJS-Webhooks/1.0",
      "webhook-id": "msg_http_1",
      "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      "webhook-signature": "v1,test",
    },
    body,
    endpointId: "ep_1",
    deliveryId: "dlv_1",
    messageId: "msg_http_1",
    type: "order.created",
  };
}

describe("AddressPolicy (SSRF protection)", () => {
  it("blocks private, loopback, link-local, metadata, and embedded IPv6 ranges by default", () => {
    const policy = new AddressPolicy();
    const blocked = [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "169.254.169.254",
      "168.63.129.16",
      "100.100.100.200",
      "::1",
      "fc00::1",
      "fe80::1",
      "fd00:ec2::254",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:0:10.0.0.1",
      "64:ff9b::10.0.0.1",
      "2002:7f00:0001::1",
    ];
    for (const ip of blocked) {
      expect(policy.check(ip).allowed).toBe(false);
    }

    expect(policy.check("93.184.216.34").allowed).toBe(true);
    expect(policy.check("2606:2800:220:1:248:1893:25c8:1946").allowed).toBe(
      true,
    );
  });

  it("allows private/loopback when allowPrivateNetworks=true while still blocking cloud metadata & link-local", () => {
    const policy = new AddressPolicy({ allowPrivateNetworks: true });
    expect(policy.check("127.0.0.1").allowed).toBe(true);
    expect(policy.check("10.0.0.1").allowed).toBe(true);
    expect(policy.check("::1").allowed).toBe(true);
    expect(policy.check("169.254.169.254").allowed).toBe(false);
    expect(policy.check("168.63.129.16").allowed).toBe(false);
    expect(policy.check("fd00:ec2::254").allowed).toBe(false);
    expect(policy.check("fe80::1").allowed).toBe(false);
  });

  it("honors explicit allowedAddresses CIDRs", () => {
    const policy = new AddressPolicy({
      allowedAddresses: ["10.20.0.0/16", "127.0.0.1/32"],
    });
    expect(policy.check("10.20.5.9").allowed).toBe(true);
    expect(policy.check("127.0.0.1").allowed).toBe(true);
    expect(policy.check("10.21.0.1").allowed).toBe(false);
  });
});

describe("HttpWebhookTransport (native Bun fetch + DNS pinning + SSRF + live Bun.serve)", () => {
  it("delivers signed POST requests with DNS pinning, refuses redirects, caps response bytes, and blocks SSRF", async () => {
    const received: Array<{
      path: string;
      host: string | null;
      webhookId: string | null;
      body: string;
    }> = [];

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.text();
        received.push({
          path: url.pathname,
          host: req.headers.get("host"),
          webhookId: req.headers.get("webhook-id"),
          body,
        });
        if (url.pathname === "/redirect") {
          return new Response("go elsewhere", {
            status: 302,
            headers: { location: "/ok" },
          });
        }
        if (url.pathname === "/big") {
          // 100x 3-byte UTF-8 character "€" (300 bytes)
          return new Response("€".repeat(100), { status: 200 });
        }
        return new Response("received-ok", {
          status: 201,
          headers: { "x-custom-reply": "yes" },
        });
      },
    });

    try {
      // 1. Default transport blocks http: and private destinations
      const strict = new HttpWebhookTransport();
      await expect(
        strict.send(makeRequest(`http://127.0.0.1:${server.port}/ok`), {
          signal: new AbortController().signal,
          attempt: 1,
        }),
      ).rejects.toThrow(WebhookDestinationBlockedError);

      // 2. DNS resolution returning a blocked IP rejects before connecting
      const dnsBlocked = new HttpWebhookTransport({
        allowHttp: true,
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      });
      let ssrfErr: unknown;
      try {
        await dnsBlocked.send(
          makeRequest(`http://evil.example.test:${server.port}/ok`),
          { signal: new AbortController().signal, attempt: 1 },
        );
      } catch (err) {
        ssrfErr = err;
      }
      expect(ssrfErr).toBeInstanceOf(WebhookDestinationBlockedError);
      expect((ssrfErr as WebhookDestinationBlockedError).address).toBe(
        "169.254.169.254",
      );

      // 3. DNS pinning delivers to resolved 127.0.0.1 while keeping Host header
      const pinned = new HttpWebhookTransport({
        allowHttp: true,
        allowPrivateNetworks: true,
        maxResponseSize: 10, // 10 bytes fits 3 full "€" chars (9 bytes), drops partial 4th char without U+FFFD
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      });

      const okRes = await pinned.send(
        makeRequest(`http://hooks.partner.test:${server.port}/ok`),
        { signal: new AbortController().signal, attempt: 1 },
      );
      expect(okRes.statusCode).toBe(201);
      expect(okRes.headers["x-custom-reply"]).toBe("yes");
      expect(okRes.body).toBe("received-o"); // capped at 10 bytes
      expect(received[0]?.host).toBe(`hooks.partner.test:${server.port}`);
      expect(received[0]?.webhookId).toBe("msg_http_1");

      // 4. Redirects are NOT followed
      const redirRes = await pinned.send(
        makeRequest(`http://127.0.0.1:${server.port}/redirect`),
        { signal: new AbortController().signal, attempt: 1 },
      );
      expect(redirRes.statusCode).toBe(302);
      expect(redirRes.headers.location).toBe("/ok");

      // 5. Multibyte UTF-8 truncation drops incomplete trailing codepoint cleanly (no U+FFFD)
      const bigRes = await pinned.send(
        makeRequest(`http://127.0.0.1:${server.port}/big`),
        { signal: new AbortController().signal, attempt: 1 },
      );
      expect(bigRes.statusCode).toBe(200);
      expect(bigRes.body).toBe("€€€");
      expect(bigRes.body.includes("\uFFFD")).toBe(false);

      // 6. Full end-to-end delivery from Webhooks.dispatch -> WebhookWorker -> HttpWebhookTransport -> live Bun.serve -> WebhookVerifier!
      const sharedSecret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
      let verifiedPayload: unknown;

      const receiverServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const rawBody = Buffer.from(await req.arrayBuffer());
          const verified = verifier.verify("partner", {
            headers: req.headers,
            rawBody,
          });
          verifiedPayload = verified.payload;
          return new Response("ok", { status: 200 });
        },
      });

      const mod = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({ relay: { enabled: false } }),
          WebhooksModule.forRoot({
            delivery: { allowHttp: true, allowPrivateNetworks: true },
            worker: { enabled: false },
            receivers: {
              partner: { scheme: "standard", secret: sharedSecret },
            },
          }),
        ],
      }).compile();
      await mod.init();
      const verifier = mod.get(WebhookVerifier);

      try {
        const endpoints = mod.get(WebhookEndpoints);
        const webhooks = mod.get(Webhooks);
        const relay = mod.get(OutboxRelay);
        const worker = mod.get(WebhookWorker);

        await endpoints.create({
          url: `http://127.0.0.1:${receiverServer.port}/live`,
          eventTypes: ["invoice.paid"],
          secret: sharedSecret,
        });
        await webhooks.dispatch(
          {},
          { type: "invoice.paid", data: { invoiceId: "inv_42", total: 9900 } },
        );
        await relay.runOnce();
        const res = await worker.runOnce();
        expect(res.delivered).toBe(1);
        expect(
          (verifiedPayload as { type: string; data: { invoiceId: string } })
            .type,
        ).toBe("invoice.paid");
        expect(
          (verifiedPayload as { data: { invoiceId: string } }).data.invoiceId,
        ).toBe("inv_42");
      } finally {
        await mod.close();
        receiverServer.stop(true);
      }
    } finally {
      server.stop(true);
    }
  });
});
