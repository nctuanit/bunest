import { describe, expect, it } from "bun:test";
import { InMemorySpanExporter } from "@bunest/observability";
import { DataSource } from "@bunest/orm";
import { Test } from "@bunest/testing";
import { createDistributedWorkerModule } from "../src/app.module";
import { OrderEventAuditListener } from "../src/orders/order-event-audit.listener";
import type { OrderRecord } from "../src/orders/order.entity";

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe("Distributed Worker Example (HTTP -> CQRS -> SQLite -> Queue -> Events + W3C Tracing)", () => {
  it("propagates a single W3C traceId across HTTP -> DB -> Queue retry -> Event and exposes /health & /metrics", async () => {
    const exporter = new InMemorySpanExporter();
    const TestModule = createDistributedWorkerModule(exporter);

    const mod = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    const app = mod.createBunestApplication();
    const client = mod.createTestClient(app);
    await app.init();

    const dataSource = mod.get(DataSource);
    const auditListener = mod.get(OrderEventAuditListener);

    try {
      const incomingTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const incomingParentSpanId = "00f067aa0ba902b7";
      const traceparent = `00-${incomingTraceId}-${incomingParentSpanId}-01`;

      // 1. POST /orders with incoming W3C traceparent and simulated transient worker failure
      const postRes = await client.post("/orders", {
        headers: { traceparent },
        json: { item: "Mechanical Keyboard", amount: 149, failOnce: true },
      });
      expect(postRes.status).toBe(201);
      expect(postRes.headers.get("traceparent")).toContain(incomingTraceId);

      const created = (await postRes.json()) as OrderRecord;
      expect(created.id).toBe(1);
      expect(created.status).toBe("pending");

      // 2. Wait for queue worker to fail attempt #1, retry, succeed on attempt #2, and emit event
      await waitUntil(() => auditListener.processedOrders.includes(1));

      const orderRes = await client.get("/orders/1");
      expect(orderRes.status).toBe(200);
      expect(await orderRes.json()).toEqual({
        id: 1,
        item: "Mechanical Keyboard",
        amount: 149,
        status: "processed",
      });

      // 3. Verify end-to-end trace spans share the single incoming traceId with parent-child links
      const spans = exporter.findByTraceId(incomingTraceId);
      const httpSpan = spans.find(
        (s) => s.kind === "SERVER" && s.name.includes("POST"),
      );
      const dbSpan = spans.find((s) => s.name === "db.insert_order");
      const queueSpans = spans.filter((s) => s.name === "queue.process_order");

      expect(httpSpan).toBeDefined();
      expect(dbSpan).toBeDefined();
      // 2 queue spans: attempt #1 (ERROR) + attempt #2 (OK)
      expect(queueSpans).toHaveLength(2);

      // Verify parent-child hierarchy: incoming -> HTTP -> DB, and HTTP -> Queue
      expect(httpSpan!.parentSpanId).toBe(incomingParentSpanId);
      expect(dbSpan!.parentSpanId).toBe(httpSpan!.spanId);
      expect(queueSpans[0]!.parentSpanId).toBe(httpSpan!.spanId);
      expect(queueSpans[0]!.status.code).toBe("ERROR");
      expect(queueSpans[1]!.parentSpanId).toBe(httpSpan!.spanId);
      expect(queueSpans[1]!.status.code).toBe("OK");

      // 4. Verify /health & /metrics endpoints
      const healthRes = await client.get("/health");
      expect(healthRes.status).toBe(200);
      const healthBody = (await healthRes.json()) as { status: string };
      expect(healthBody.status).toBe("ok");

      const metricsRes = await client.get("/metrics");
      expect(metricsRes.status).toBe(200);
      const metricsText = await metricsRes.text();
      expect(metricsText).toContain("http_requests_total");
    } finally {
      await app.close();
    }

    expect(dataSource.isInitialized).toBe(false);
  });
});
