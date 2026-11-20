import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import {
  Controller,
  HttpCode,
  Module,
  Post,
  Reflector,
  UnsupportedMediaTypeException,
  type ExecutionContext,
  type StandardSchemaV1,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { OutboxInbox, OutboxModule } from "@bunest/outbox";
import { Test } from "@bunest/testing";
import { WebhookSignatureGuard } from "../src/guards/webhook-signature.guard";
import {
  IncomingWebhook,
  VerifyWebhook,
  WebhookPayload,
  WebhookSignatureScheme,
  WebhookVerificationError,
  WebhookVerifier,
  WebhooksEvents,
  WebhooksModule,
  type WebhookSignatureCheck,
  type WebhookSignedRequest,
  type WebhooksEvent,
} from "../src/index";
import { signWebhook } from "../src/testing/index";

const STD_SECRET_1 = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const STD_SECRET_2 = "whsec_c2VjcmV0X2tleV9mb3Jfcm90YXRpb25fMTIzNDU2Nzg=";
const STRIPE_SECRET = "whsec_stripe_signing_secret_123456";
const GITHUB_SECRET = "github_webhook_secret_abcdef";

class CustomHeaderScheme extends WebhookSignatureScheme {
  override verify(
    { headers, rawBody }: WebhookSignedRequest,
    keys: readonly Buffer[],
  ): WebhookSignatureCheck {
    const sig = headers["x-custom-sig"];
    const id = headers["x-custom-id"];
    if (typeof sig !== "string") {
      return {
        valid: false,
        reason: "missing-header",
        detail: "missing x-custom-sig",
      };
    }
    const candidate = Buffer.from(sig, "hex");
    for (const key of keys) {
      const expected = createHmac("sha256", key).update(rawBody).digest();
      if (WebhookSignatureScheme.matches(expected, [candidate])) {
        return {
          valid: true,
          id: typeof id === "string" ? id : undefined,
        };
      }
    }
    return {
      valid: false,
      reason: "invalid-signature",
      detail: "bad custom sig",
    };
  }
}

describe("WebhookVerifier & signature schemes", () => {
  it("verifies Standard Webhooks, Stripe, GitHub, and custom schemes with rotation & tolerance", async () => {
    const customScheme = new CustomHeaderScheme();
    const mod = await Test.createTestingModule({
      imports: [
        OutboxModule.forRoot({ relay: { enabled: false } }),
        WebhooksModule.forRoot({
          outgoing: false,
          receivers: {
            payments: {
              scheme: "standard",
              secret: [STD_SECRET_2, STD_SECRET_1],
              tolerance: "5m",
            },
            stripe: {
              scheme: "stripe",
              secret: STRIPE_SECRET,
              tolerance: "2m",
            },
            stripeCustom: {
              scheme: "stripe",
              secret: STRIPE_SECRET,
              header: "X-Vendor-Signature",
              id: (payload) => `custom:${payload.eventId}`,
            },
            github: {
              scheme: "github",
              secret: GITHUB_SECRET,
            },
            custom: {
              scheme: customScheme,
              secret: "my-custom-secret",
            },
          },
        }),
      ],
    }).compile();

    await mod.init();
    try {
      const verifier = mod.get(WebhookVerifier);
      const events = mod.get(WebhooksEvents);
      expect(verifier.receivers.sort()).toEqual([
        "custom",
        "github",
        "payments",
        "stripe",
        "stripeCustom",
      ]);

      // 1. Standard Webhooks signed with rotated-out secret (STD_SECRET_1)
      const stdSigned = signWebhook({
        scheme: "standard",
        secret: STD_SECRET_1,
        payload: { type: "payment.paid", amount: 4200 },
        id: "msg_std_1",
      });
      const verifiedStd = verifier.verify<{ type: string; amount: number }>(
        "payments",
        { headers: stdSigned.headers, rawBody: stdSigned.body },
      );
      expect(verifiedStd.receiver).toBe("payments");
      expect(verifiedStd.id).toBe("msg_std_1");
      expect(verifiedStd.payload).toEqual({
        type: "payment.paid",
        amount: 4200,
      });
      expect(verifiedStd.timestamp).toBeInstanceOf(Date);
      expect(verifiedStd.rawBody.toString("utf8")).toBe(stdSigned.body);

      // 2. Stripe default header (id read from payload.id)
      const stripeSigned = signWebhook({
        scheme: "stripe",
        secret: STRIPE_SECRET,
        payload: { id: "evt_stripe_1", type: "charge.succeeded" },
      });
      const verifiedStripe = verifier.verify<{ id: string }>("stripe", {
        headers: new Headers(stripeSigned.headers),
        rawBody: Buffer.from(stripeSigned.body, "utf8"),
      });
      expect(verifiedStripe.id).toBe("evt_stripe_1");
      expect(verifiedStripe.timestamp).toBeInstanceOf(Date);

      // 3. Stripe custom header + custom id extractor
      const stripeCustomSigned = signWebhook({
        scheme: "stripe",
        secret: STRIPE_SECRET,
        header: "X-Vendor-Signature",
        payload: { eventId: "v_99" },
      });
      const verifiedStripeCustom = verifier.verify("stripeCustom", {
        headers: stripeCustomSigned.headers,
        rawBody: stripeCustomSigned.body,
      });
      expect(verifiedStripeCustom.id).toBe("custom:v_99");

      // 4. GitHub scheme
      const ghSigned = signWebhook({
        scheme: "github",
        secret: GITHUB_SECRET,
        payload: { action: "opened" },
        id: "gh_delivery_1",
      });
      const verifiedGh = verifier.verify<{ action: string }>("github", {
        headers: ghSigned.headers,
        rawBody: ghSigned.body,
      });
      expect(verifiedGh.id).toBe("gh_delivery_1");
      expect(verifiedGh.timestamp).toBeNull();
      expect(verifiedGh.payload.action).toBe("opened");

      // 5. Custom scheme
      const customBody = JSON.stringify({ hello: "world" });
      const customSig = createHmac("sha256", "my-custom-secret")
        .update(customBody)
        .digest("hex");
      const verifiedCustom = verifier.verify<{ hello: string }>("custom", {
        headers: { "x-custom-sig": customSig, "x-custom-id": "cust_1" },
        rawBody: customBody,
      });
      expect(verifiedCustom.id).toBe("cust_1");
      expect(verifiedCustom.payload.hello).toBe("world");

      // 6. Timestamp out of tolerance + verification-failed event & diagnostics_channel
      const observed: WebhooksEvent[] = [];
      const diagObserved: unknown[] = [];
      const sub = events.events$.subscribe((ev) => observed.push(ev));
      const diagHandler = (msg: unknown) => diagObserved.push(msg);
      subscribe("nestjs:webhooks:verification-failed", diagHandler);
      try {
        const oldSigned = signWebhook({
          scheme: "standard",
          secret: STD_SECRET_2,
          payload: { ok: true },
          timestamp: new Date(Date.now() - 10 * 60_000),
        });
        expect(() =>
          verifier.verify("payments", {
            headers: oldSigned.headers,
            rawBody: oldSigned.body,
          }),
        ).toThrow(WebhookVerificationError);

        // Invalid JSON body with valid signature -> status 400
        const badJson = signWebhook({
          scheme: "standard",
          secret: STD_SECRET_2,
          payload: "not-json{",
        });
        let badJsonErr: unknown;
        try {
          verifier.verify("payments", {
            headers: badJson.headers,
            rawBody: badJson.body,
          });
        } catch (err) {
          badJsonErr = err;
        }
        expect(badJsonErr).toBeInstanceOf(WebhookVerificationError);
        expect((badJsonErr as WebhookVerificationError).status).toBe(400);
        expect((badJsonErr as WebhookVerificationError).reason).toBe(
          "invalid-payload",
        );

        // Overlong id (> 255 code points) -> malformed-header
        const longId = signWebhook({
          scheme: "standard",
          secret: STD_SECRET_2,
          payload: { ok: true },
          id: "a".repeat(256),
        });
        expect(() =>
          verifier.verify("payments", {
            headers: longId.headers,
            rawBody: longId.body,
          }),
        ).toThrow(/255/);

        expect(observed.map((e) => e.type)).toEqual([
          "verification-failed",
          "verification-failed",
          "verification-failed",
        ]);
        expect(diagObserved.length).toBe(3);
      } finally {
        sub.unsubscribe();
        unsubscribe("nestjs:webhooks:verification-failed", diagHandler);
      }

      // 7. processInTransaction deduplicates via OutboxInbox
      let runs = 0;
      const firstTx = await verifiedStd.processInTransaction({}, () => {
        runs++;
        return "processed";
      });
      const secondTx = await verifiedStd.processInTransaction({}, () => {
        runs++;
        return "again";
      });
      expect(firstTx).toEqual({ duplicate: false, result: "processed" });
      expect(secondTx).toEqual({ duplicate: true });
      expect(runs).toBe(1);
    } finally {
      await mod.close();
    }
  });
});

describe("@VerifyWebhook() HTTP E2E (Bunest RequestContext + rawBody + deduplication)", () => {
  it("verifies signatures, parses payload with Standard Schema, deduplicates via OutboxInbox, and rejects bad requests", async () => {
    let handledCount = 0;
    let unDedupedCount = 0;

    const paymentSchema: StandardSchemaV1<unknown, { orderId: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value) {
          if (
            value &&
            typeof value === "object" &&
            typeof (value as { orderId?: unknown }).orderId === "string"
          ) {
            return { value: { orderId: (value as { orderId: string }).orderId } };
          }
          return { issues: [{ message: "orderId must be a string" }] };
        },
      },
    };

    @Controller("hooks")
    class HooksController {
      @Post("payments")
      @HttpCode(200)
      @VerifyWebhook("payments")
      handlePayment(
        @WebhookPayload(paymentSchema) payload: { orderId: string },
        @IncomingWebhook() webhook: IncomingWebhook<{ orderId: string }>,
      ) {
        handledCount++;
        return {
          ok: true,
          id: webhook.id,
          receiver: webhook.receiver,
          orderId: payload.orderId,
          rawLen: webhook.rawBody.length,
        };
      }

      @Post("github")
      @HttpCode(200)
      @VerifyWebhook("github")
      handleGithub(@WebhookPayload() payload: { ref: string }) {
        unDedupedCount++;
        return { ref: payload.ref };
      }
    }

    @Module({
      imports: [
        OutboxModule.forRoot({ relay: { enabled: false } }),
        WebhooksModule.forRoot({
          outgoing: false,
          receivers: {
            payments: { scheme: "standard", secret: STD_SECRET_1 },
            github: { scheme: "github", secret: GITHUB_SECRET, dedupe: false },
          },
        }),
      ],
      controllers: [HooksController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, {
      rawBody: true,
      logger: false,
    });
    await app.init();

    try {
      // 1. Valid Standard Webhook -> 200 with verified payload & IncomingWebhook metadata
      const signed = signWebhook({
        scheme: "standard",
        secret: STD_SECRET_1,
        payload: { orderId: "ord_123" },
        id: "msg_dedupe_1",
      });
      const res1 = await app.inject({
        method: "POST",
        url: "/hooks/payments",
        headers: signed.headers,
        body: signed.body,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json()).toEqual({
        ok: true,
        id: "msg_dedupe_1",
        receiver: "payments",
        orderId: "ord_123",
        rawLen: Buffer.byteLength(signed.body, "utf8"),
      });
      expect(handledCount).toBe(1);

      // 2. Duplicate delivery with same webhook-id -> empty 200, handler NOT invoked again
      const res2 = await app.inject({
        method: "POST",
        url: "/hooks/payments",
        headers: signed.headers,
        body: signed.body,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.body).toBe("");
      expect(handledCount).toBe(1);

      // 3. Invalid signature -> 401 without leaking verification reason
      const badSig = await app.inject({
        method: "POST",
        url: "/hooks/payments",
        headers: {
          ...signed.headers,
          "webhook-signature": "v1,aW52YWxpZA==",
        },
        body: signed.body,
      });
      expect(badSig.statusCode).toBe(401);
      expect(badSig.body).toContain("Webhook signature verification failed");
      expect(badSig.body).not.toContain("invalid-signature");

      // 4. Valid signature, invalid JSON body -> 400
      const invalidJson = signWebhook({
        scheme: "standard",
        secret: STD_SECRET_1,
        payload: "{bad json",
      });
      const resBadJson = await app.inject({
        method: "POST",
        url: "/hooks/payments",
        headers: invalidJson.headers,
        body: invalidJson.body,
      });
      expect(resBadJson.statusCode).toBe(400);

      // 5. Valid signature & JSON, fails Standard Schema validation -> 400
      const badSchema = signWebhook({
        scheme: "standard",
        secret: STD_SECRET_1,
        payload: { orderId: 999 },
      });
      const resBadSchema = await app.inject({
        method: "POST",
        url: "/hooks/payments",
        headers: badSchema.headers,
        body: badSchema.body,
      });
      expect(resBadSchema.statusCode).toBe(400);

      // 6. Receiver with dedupe: false runs handler on duplicate id
      const gh = signWebhook({
        scheme: "github",
        secret: GITHUB_SECRET,
        payload: { ref: "refs/heads/main" },
        id: "gh_same",
      });
      const gh1 = await app.inject({
        method: "POST",
        url: "/hooks/github",
        headers: gh.headers,
        body: gh.body,
      });
      const gh2 = await app.inject({
        method: "POST",
        url: "/hooks/github",
        headers: gh.headers,
        body: gh.body,
      });
      expect(gh1.statusCode).toBe(200);
      expect(gh2.statusCode).toBe(200);
      expect(unDedupedCount).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("works synchronously with plain Express/Fastify-style mock requests in WebhookSignatureGuard", async () => {
    const mod = await Test.createTestingModule({
      imports: [
        WebhooksModule.forRoot({
          outgoing: false,
          receivers: {
            payments: {
              scheme: "standard",
              secret: STD_SECRET_1,
              dedupe: false,
            },
          },
        }),
      ],
    }).compile();
    await mod.init();

    try {
      const verifier = mod.get(WebhookVerifier);
      const reflector = new Reflector();
      const guard = new WebhookSignatureGuard(reflector, verifier);

      class DummyController {
        @VerifyWebhook("payments")
        receive() {}
      }

      const signed = signWebhook({
        scheme: "standard",
        secret: STD_SECRET_1,
        payload: { ok: true },
        id: "msg_sync_1",
      });
      const mockReq = {
        headers: signed.headers,
        rawBody: Buffer.from(signed.body, "utf8"),
      };
      const execCtx = {
        getType: () => "http",
        getClass: () => DummyController,
        getHandler: () => DummyController.prototype.receive,
        switchToHttp: () => ({ getRequest: () => mockReq }),
      } as unknown as ExecutionContext;

      // Returns synchronous boolean `true` when rawBody Buffer is present
      const allowed = guard.canActivate(execCtx);
      expect(allowed).toBe(true);

      // Missing rawBody with non-JSON content-type -> UnsupportedMediaTypeException
      const badCtReq = {
        headers: { "content-type": "text/plain", "content-length": "5" },
      };
      const badCtCtx = {
        ...execCtx,
        switchToHttp: () => ({ getRequest: () => badCtReq }),
      } as unknown as ExecutionContext;
      expect(() => guard.canActivate(badCtCtx)).toThrow(
        UnsupportedMediaTypeException,
      );
    } finally {
      await mod.close();
    }
  });

  it("fails startup when @VerifyWebhook names an unknown receiver or dedupe lacks OutboxModule", async () => {
    @Controller("bad")
    class UnknownReceiverController {
      @Post()
      @VerifyWebhook("missing")
      handle() {}
    }

    const badMod = await Test.createTestingModule({
      imports: [
        WebhooksModule.forRoot({
          outgoing: false,
          receivers: {
            known: { scheme: "standard", secret: STD_SECRET_1, dedupe: false },
          },
        }),
      ],
      controllers: [UnknownReceiverController],
    }).compile();
    await expect(badMod.init()).rejects.toThrow(/@VerifyWebhook\('missing'\) names no receiver/);

    @Controller("dedupe-no-outbox")
    class DedupeWithoutOutboxController {
      @Post()
      @VerifyWebhook("payments")
      handle() {}
    }

    const noOutboxMod = await Test.createTestingModule({
      imports: [
        WebhooksModule.forRoot({
          outgoing: false,
          receivers: {
            payments: { scheme: "standard", secret: STD_SECRET_1, dedupe: true },
          },
        }),
      ],
      controllers: [DedupeWithoutOutboxController],
    }).compile();
    await expect(noOutboxMod.init()).rejects.toThrow(/deduplicates webhook ids with OutboxInbox/);
  });
});
