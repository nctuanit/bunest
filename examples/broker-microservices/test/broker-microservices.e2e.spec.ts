import { describe, expect, it } from "bun:test";
import { MicroserviceHost } from "@bunest/microservices";
import { Test } from "@bunest/testing";
import { createBrokerMicroservicesModule } from "../src/app.module";
import { OrdersHttpController } from "../src/orders.http-controller";
import { PaymentGatewayService } from "../src/payments.service";

describe("Resilient Broker Microservices (Idempotency + CLS + Retry/Breaker/Fallback + DLQ)", () => {
  it("deduplicates POST /orders via @Idempotent, propagates CLS over RPC, retries/falls back payments, and captures poison events in DLQ", async () => {
    const { AppModule, rpcClient } = createBrokerMicroservicesModule();
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();
    const host = app.get(MicroserviceHost);
    await host.listen();

    try {
      const ordersController = app.get(OrdersHttpController);
      const payments = app.get(PaymentGatewayService);

      // 1. First POST /orders: retries transient payment error once, propagates CLS across RPC & audit event
      const firstRes = await app.fetch(
        new Request("http://localhost/orders", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "idem-order-100",
            "x-tenant-id": "tenant-acme",
            "x-correlation-id": "corr-999",
          },
          body: JSON.stringify({ sku: "BUN-TEE", quantity: 2 }),
        }),
      );
      expect(firstRes.status).toBe(201);
      const firstBody = (await firstRes.json()) as {
        orderId: string;
        reservation: {
          reservationId: string;
          sku: string;
          tenantId: string;
          correlationId: string;
        };
        payment: { status: string; attempts: number };
      };
      expect(firstBody.orderId).toBe("ord_1");
      expect(firstBody.reservation).toMatchObject({
        sku: "BUN-TEE",
        tenantId: "tenant-acme",
        correlationId: "corr-999",
      });
      // First attempt failed transiently; @Retry recovered on attempt 2
      expect(firstBody.payment).toMatchObject({
        status: "charged",
        attempts: 2,
      });
      expect(payments.chargeAttempts).toBe(2);

      // 2. Retry exact same POST with same Idempotency-Key -> replayed without re-executing handler!
      const replayRes = await app.fetch(
        new Request("http://localhost/orders", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "idem-order-100",
            "x-tenant-id": "tenant-acme",
            "x-correlation-id": "corr-999",
          },
          body: JSON.stringify({ sku: "BUN-TEE", quantity: 2 }),
        }),
      );
      expect(replayRes.status).toBe(201);
      expect(await replayRes.json()).toEqual(firstBody);
      expect(ordersController.executionCount).toBe(1);

      // 3. Downstream payment outage -> @CircuitBreaker + @Fallback degrades gracefully to "deferred"
      const outageRes = await app.fetch(
        new Request("http://localhost/orders", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "idem-order-101",
          },
          body: JSON.stringify({
            sku: "BUN-CAP",
            quantity: 1,
            simulateOutage: true,
          }),
        }),
      );
      expect(outageRes.status).toBe(201);
      const outageBody = (await outageRes.json()) as {
        payment: { status: string; chargeId: string };
      };
      expect(outageBody.payment).toMatchObject({
        status: "deferred",
        chargeId: "chg_deferred_queue",
      });

      // 4. Audit event preserved CLS context & metadata
      const auditRes = await app.fetch(
        new Request("http://localhost/orders/audit"),
      );
      const audits = (await auditRes.json()) as Array<{
        orderId: string;
        tenantId?: string;
        correlationId?: string;
        origin?: string;
      }>;
      expect(audits[0]).toMatchObject({
        orderId: "ord_1",
        tenantId: "tenant-acme",
        correlationId: "corr-999",
        origin: "orders-http",
      });

      // 5. Poison event routes to dead-letter handler without crashing microservice host
      const poisonRes = await app.fetch(
        new Request("http://localhost/orders/poison", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId: "ord_poison_7" }),
        }),
      );
      expect(poisonRes.status).toBe(201);

      const dlqRes = await app.fetch(new Request("http://localhost/orders/dlq"));
      const dlq = (await dlqRes.json()) as Array<{
        pattern: string;
        data: { orderId: string };
        errorMessage: string;
        metadata?: Record<string, unknown>;
      }>;
      expect(dlq).toHaveLength(1);
      expect(dlq[0]).toMatchObject({
        pattern: "orders.poison",
        data: { orderId: "ord_poison_7" },
        errorMessage: "Poison event for order ord_poison_7",
        metadata: { "x-source": "dead-letter-demo" },
      });
    } finally {
      await rpcClient.close();
      await app.close();
    }
  });
});
