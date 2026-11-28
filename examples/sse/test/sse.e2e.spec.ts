import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";
import { NotificationsService } from "../src/notifications.service";

describe("Server-Sent Events (NestJS 28-sse E2E)", () => {
  it("serves EventSource HTML page, streams @Sse() ticks, and broadcasts live push notifications", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    try {
      // 1. HTML demo page
      const htmlRes = await app.fetch(new Request("http://localhost/"));
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get("content-type")).toContain("text/html");
      expect(await htmlRes.text()).toContain("new EventSource");

      // 2. Timed SSE stream
      const sseRes = await app.fetch(
        new Request("http://localhost/sse?count=3&intervalMs=5"),
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
      const sseBody = await sseRes.text();
      expect(sseBody).toContain("event: tick");
      expect(sseBody).toContain("id: 1");
      expect(sseBody).toContain("retry: 3000");
      expect(sseBody).toContain('data: {"hello":"world","seq":1}');
      expect(sseBody).toContain('data: {"hello":"world","seq":3}');

      // 3. Live push notification stream
      const notifications = mod.get(NotificationsService);
      const streamRes = await app.fetch(
        new Request("http://localhost/notifications?limit=2"),
      );
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get("content-type")).toContain(
        "text/event-stream",
      );

      // Wait briefly for stream subscriber registration, then push two events
      await Bun.sleep(10);
      expect(notifications.subscriberCount).toBe(1);

      const p1 = await app.fetch(
        new Request("http://localhost/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Order #101 shipped" }),
        }),
      );
      expect(p1.status).toBe(201);

      const p2 = await app.fetch(
        new Request("http://localhost/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Order #102 delivered" }),
        }),
      );
      expect(p2.status).toBe(201);

      const feedText = await streamRes.text();
      expect(feedText).toContain("event: notification");
      expect(feedText).toContain("Order #101 shipped");
      expect(feedText).toContain("Order #102 delivered");
      expect(notifications.subscriberCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});
