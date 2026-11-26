import { describe, expect, it } from "bun:test";
import { loadBunestConfig } from "@bunest/cli";
import { BunestFactory, resolve } from "@bunest/core";
import { AppModule } from "../src/app.module";
import { ShowcaseAspectTrace } from "../src/magic/aop-pipeline";
import {
  DevShowcaseBanner,
  ShowcaseCacheStore,
} from "../src/magic/conditional-cache";
import { OrderRepository } from "../src/orders/order.repository";
import { Money, slugifyText } from "../src/users/money.vo";
import { UsersService } from "../src/users/users.service";

describe("Bunest VS Code Extension Showcase", () => {
  it("runs declarative CrudRepository + Events end-to-end", async () => {
    const app = await BunestFactory.create(AppModule);
    await app.init();
    try {
      const users = app.get(UsersService);
      const all = await users.findAll();
      expect(all.length).toBe(2);

      const created = await users.create({
        email: "charlie@bunest.dev",
        name: "Charlie Le",
        age: 31,
      });
      expect(created.email).toBe("charlie@bunest.dev");

      const m1 = new Money(50, "USD");
      const m2 = m1.withAmount(100);
      expect(m2.amount).toBe(100);
      expect(Object.isFrozen(m2)).toBe(true);
      expect(slugifyText("  Hello Bunest  ")).toBe("hello-bunest");
    } finally {
      await app.close();
    }
  });

  it("demonstrates @SoftDelete, Page<T>, custom ORM operators, AOP AspectPhase pipeline, and bunest.config.ts", async () => {
    const showcaseRoot = resolve(import.meta.dir, "..");
    const loaded = await loadBunestConfig(showcaseRoot);
    expect(loaded.configPath).toContain("bunest.config.ts");
    expect(loaded.config.orm?.queryOperators?.map((o) => o.suffix)).toContain(
      "IContains",
    );

    const app = await BunestFactory.create(AppModule);
    await app.init();
    try {
      // AspectPhase + defineAspectPipeline (@AuditedOperation) phase ordering
      const trace = app.get(ShowcaseAspectTrace);
      trace.clear();
      const users = app.get(UsersService);
      await users.findAll();
      expect(trace.events).toEqual([
        "observability:before:users.findAll",
        "audit:before:users.findAll",
        "audit:after:users.findAll",
        "observability:after:users.findAll",
      ]);

      const cache = app.get(ShowcaseCacheStore);
      cache.set("k1", "v1");
      expect(cache.get("k1")).toBe("v1");
      const banner = app.get(DevShowcaseBanner);
      expect(banner.getBanner()).toContain("Bunest Showcase");

      // @SoftDelete + Page<T> + custom IContains ORM operator + this.queryOne
      const orders = app.get(OrderRepository);
      const o1 = await orders.save({
        orderCode: "ORD-ALPHA-001",
        status: "PAID",
        totalCents: 1500,
      });
      await orders.save({
        orderCode: "ORD-BETA-002",
        status: "PAID",
        totalCents: 2500,
      });
      await orders.save({
        orderCode: "ORD-GAMMA-003",
        status: "PAID",
        totalCents: 3500,
      });

      const matchedAlpha = await orders.findAllByOrderCodeIContains("alpha");
      expect(matchedAlpha).toHaveLength(1);
      expect(matchedAlpha[0]!.orderCode).toBe("ORD-ALPHA-001");

      const summary = await orders.findSummaryByOrderCode("ORD-ALPHA-001");
      expect(summary).toEqual({
        id: o1.id,
        orderCode: "ORD-ALPHA-001",
        status: "PAID",
      });
      expect("totalCents" in (summary as Record<string, unknown>)).toBe(false);

      const page1 = await orders.findPageByStatus("PAID", { page: 1, size: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(3);
      expect(page1.totalPages).toBe(2);
      expect(page1.hasNext).toBe(true);

      await orders.deleteById(o1.id);
      const visiblePaid = await orders.findAllByStatus("PAID");
      expect(visiblePaid).toHaveLength(2);
      const totalIncludingDeleted =
        await orders.countAllByStatusIncludingDeleted("PAID");
      expect(totalIncludingDeleted).toBe(3);

      const searchRes = await app.fetch(new Request("http://localhost/orders?search=beta"));
      expect(searchRes.status).toBe(200);
      const searchBody = (await searchRes.json()) as { count: number; items: Array<{ orderCode: string }> };
      expect(searchBody.count).toBe(1);
      expect(searchBody.items[0]!.orderCode).toBe("ORD-BETA-002");

      const summaryRes = await app.fetch(new Request("http://localhost/orders/ORD-BETA-002"));
      expect(summaryRes.status).toBe(200);
      const summaryBody = (await summaryRes.json()) as Record<string, unknown>;
      expect(summaryBody.orderCode).toBe("ORD-BETA-002");
      expect("totalCents" in summaryBody).toBe(false);

      const statsRes = await app.fetch(new Request("http://localhost/orders/stats?status=PAID"));
      expect(statsRes.status).toBe(200);
      expect(await statsRes.json()).toEqual({
        status: "PAID",
        activeCount: 2,
        totalIncludingDeleted: 3,
      });
    } finally {
      await app.close();
    }
  });
});
