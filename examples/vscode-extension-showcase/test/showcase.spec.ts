import { describe, expect, it } from "bun:test";
import { loadBunestConfig } from "@bunest/cli";
import { BunestFactory, resolve } from "@bunest/core";
import { AppModule } from "../src/app.module";
import { ShowcaseAspectTrace } from "../src/magic/aop-pipeline";
import {
  DevShowcaseBanner,
  ShowcaseCacheStore,
} from "../src/magic/conditional-cache";
import { AuditNote } from "../src/magic/custom-macros";
import { OrderRepository } from "../src/orders/order.repository";
import { FormatUtils, InvoiceRecord, Money, UserProfile } from "../src/users/money.vo";
import { UserEntity } from "../src/users/user.entity";
import { UsersService } from "../src/users/users.service";

/**
 * 👉 Mở file này trong IDE sẽ thấy CodeLens `▶ Run bun test` ở ngay dòng 1!
 */
describe("Bunest VS Code Extension Showcase", () => {
  it("runs declarative CrudRepository + Class Macros + Events end-to-end", async () => {
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
      expect(UserEntity.Fields.email).toBe("email");

      // Class Macros runtime checks
      const m1 = Money.of({ amount: 50, currency: "USD" });
      const m2 = m1.withAmountBy((a) => a * 2);
      expect(m2.amount).toBe(100);
      expect(Object.isFrozen(m2)).toBe(true);

      const inv = InvoiceRecord.builder().id(10).total(250).status("PAID").build();
      expect(inv.createdBy).toBe("system");
      expect(inv.total).toBe(250);

      const profile = new UserProfile();
      expect(profile.bio("Bunest Dev").bio()).toBe("Bunest Dev");
      expect(FormatUtils.slugify("  Hello Bunest  ")).toBe("hello-bunest");
    } finally {
      await app.close();
    }
  });

  it("demonstrates Wave 1 customizable magic: custom macros/presets, @SoftDelete/@Projection/Page<T>/custom ORM operators, AOP AspectPhase pipeline, conditional beans, and bunest.config.ts", async () => {
    // 1. bunest.config.ts loader
    const showcaseRoot = resolve(import.meta.dir, "..");
    const loaded = await loadBunestConfig(showcaseRoot);
    expect(loaded.configPath).toContain("bunest.config.ts");
    expect(loaded.config.macros?.presets?.DomainEntity).toEqual([
      "Data",
      "Builder",
      "FieldNameConstants",
    ]);
    expect(loaded.config.orm?.queryOperators?.map((o) => o.suffix)).toContain(
      "IContains",
    );

    // 2. defineClassMacro (@Auditable) + defineMacroPreset (@DomainEntity) on AuditNote
    const note = AuditNote.builder().id(7).title("Launch Magic").build();
    expect(note.getId()).toBe(7);
    expect(note.getTitle()).toBe("Launch Magic");
    expect(note.auditTag).toBe("showcase");
    expect(AuditNote.Fields.title).toBe("title");
    expect(AuditNote.auditVersion()).toBe(1);
    note.markUpdated("alice");
    expect(note.updatedBy).toBe("alice");

    const app = await BunestFactory.create(AppModule, {
      profiles: ["development"],
    });
    await app.init();
    try {
      // 3. AspectPhase + defineAspectPipeline (@AuditedOperation) phase ordering
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

      // 4. Conditional beans: @RegisterIfMissing(ShowcaseCacheStore) + @Profile("!production")
      const cache = app.get(ShowcaseCacheStore);
      cache.set("k1", "v1");
      expect(cache.get("k1")).toBe("v1");
      const banner = app.get(DevShowcaseBanner);
      expect(banner.getBanner()).toContain("non-production");

      // 5. @SoftDelete + @Projection + Page<T> + @IgnoreScope + custom IContains ORM operator
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

      // Custom operator `IContains`
      const matchedAlpha = await orders.findAllByOrderCodeIContains("alpha");
      expect(matchedAlpha).toHaveLength(1);
      expect(matchedAlpha[0]!.orderCode).toBe("ORD-ALPHA-001");

      // @Projection("id", "orderCode", "status") omits `totalCents`
      const projected = await orders.findByOrderCode("ORD-ALPHA-001");
      expect(projected).toEqual({
        id: o1.id,
        orderCode: "ORD-ALPHA-001",
        status: "PAID",
      });
      expect("totalCents" in (projected as Record<string, unknown>)).toBe(false);

      // Page<T> pagination
      const page1 = await orders.findPageByStatus("PAID", { page: 1, size: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(3);
      expect(page1.totalPages).toBe(2);
      expect(page1.hasNext).toBe(true);

      // @SoftDelete hides soft-deleted row from standard reads while @IgnoreScope("softDelete") sees all 3!
      await orders.deleteById(o1.id);
      const visiblePaid = await orders.findAllByStatus("PAID");
      expect(visiblePaid).toHaveLength(2);
      const totalIncludingDeleted = await orders.countByStatus("PAID");
      expect(totalIncludingDeleted).toBe(3);

      // 6. HTTP routes for OrdersController (/orders, /orders?search=, /orders/:code, /orders/stats)
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
