import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule, configureEventEmitterApp } from "../src/app.module";
import type { RecordedOrderEvent } from "../src/orders/listeners/order-created.listener";
import type { OrderRecord } from "../src/orders/orders.service";

describe("Event Emitter (NestJS 30-event-emitter E2E)", () => {
  it("dispatches sync, wildcard, async, and @EmitEvent listeners across order lifecycle", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    configureEventEmitterApp(app);
    const client = mod.createTestClient(app);
    await app.init();

    try {
      // 1. POST /orders -> triggers order.created + wildcard order.*
      const createRes = await client.post("/orders", {
        json: {
          name: "Bunest Hoodie",
          description: "Limited edition XL",
        },
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as OrderRecord;
      expect(created.id).toBe(2);
      expect(created.status).toBe("pending");

      // 2. POST /orders/2/ship -> @EmitEvent("order.shipped") triggers order.shipped + wildcard order.*
      const shipRes = await client.post("/orders/2/ship");
      expect(shipRes.status).toBe(201);
      expect(((await shipRes.json()) as OrderRecord).status).toBe("shipped");

      // Give async wildcard listeners a tick to settle
      await Bun.sleep(20);

      // 3. Verify all listener entries recorded
      const eventsRes = await client.get("/orders/events");
      expect(eventsRes.status).toBe(200);
      const events = (await eventsRes.json()) as RecordedOrderEvent[];

      expect(
        events.some(
          (e) =>
            e.handler === "order.created" &&
            e.summary.includes("Created order #2: Bunest Hoodie"),
        ),
      ).toBe(true);
      expect(
        events.some(
          (e) =>
            e.handler === "order.shipped" &&
            e.summary.includes("Shipped order #2 (shipped)"),
        ),
      ).toBe(true);
      expect(
        events.filter((e) => e.handler === "order.*").length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });
});
