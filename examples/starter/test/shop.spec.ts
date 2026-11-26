import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "../src/app.module";

describe("Bunest Sneaker Shop (Starter E2E with Relations)", () => {
  it("loads Brand <-> Shoe and Order <-> OrderItem <-> Shoe relations, places multi-item transactional orders, and computes sales stats", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    try {
      // 1. Health check
      const healthRes = await app.fetch(new Request("http://localhost/health"));
      expect(healthRes.status).toBe(200);

      // 2. Brands include their related shoes (OneToMany)
      const brandsRes = await app.fetch(new Request("http://localhost/brands"));
      expect(brandsRes.status).toBe(200);
      const brands = (await brandsRes.json()) as Array<{
        id: number;
        name: string;
        shoes: Array<{ sku: string }>;
      }>;
      expect(brands.length).toBe(5);
      const nike = brands.find((b) => b.name === "Nike")!;
      expect(nike.shoes.map((s) => s.sku)).toEqual(["NIKE-AF1-42"]);

      // 3. Shoes include their related brand (ManyToOne)
      const listRes = await app.fetch(new Request("http://localhost/shoes"));
      expect(listRes.status).toBe(200);
      const shoes = (await listRes.json()) as Array<{
        id: number;
        sku: string;
        price: number;
        stock: number;
        brand: { id: number; name: string };
      }>;
      expect(shoes.length).toBe(5);
      expect(shoes[0]!.brand.name).toBeTruthy();

      // 4. Search across shoes + brands JOIN via this.query(...)
      const searchRes = await app.fetch(
        new Request("http://localhost/shoes?q=Nike&maxPrice=3000000"),
      );
      expect(searchRes.status).toBe(200);
      const nikeList = (await searchRes.json()) as Array<{
        sku: string;
        brandName: string;
      }>;
      expect(nikeList.map((s) => s.sku)).toEqual(["NIKE-AF1-42"]);
      expect(nikeList[0]!.brandName).toBe("Nike");

      // 5. Create new sneaker linked to Nike + update price via mergeDefined
      const createRes = await app.fetch(
        new Request("http://localhost/shoes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sku: "JORDAN-1-42",
            name: "Air Jordan 1 Retro High OG",
            brandId: nike.id,
            category: "Basketball",
            size: 42,
            price: 5_200_000,
            stock: 3,
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      const jordan = (await createRes.json()) as {
        id: number;
        brand: { name: string };
      };
      expect(jordan.brand.name).toBe("Nike");

      const patchRes = await app.fetch(
        new Request(`http://localhost/shoes/${jordan.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ price: 4_990_000 }),
        }),
      );
      expect(patchRes.status).toBe(200);
      expect(((await patchRes.json()) as { price: number }).price).toBe(4_990_000);

      // 6. Place multi-item order (Order -> OrderItem -> Shoe -> Brand) in a single transaction
      const af1 = shoes.find((s) => s.sku === "NIKE-AF1-42")!;
      const orderRes = await app.fetch(
        new Request("http://localhost/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customerName: "Nguyen Van A",
            customerPhone: "0909123456",
            items: [
              { shoeId: jordan.id, quantity: 2 },
              { shoeId: af1.id, quantity: 1 },
            ],
          }),
        }),
      );
      expect(orderRes.status).toBe(201);
      const order = (await orderRes.json()) as {
        id: number;
        orderCode: string;
        totalAmount: number;
        status: string;
        items: Array<{
          quantity: number;
          shoe: { sku: string; brand: { name: string } };
        }>;
      };
      expect(order.orderCode).toMatch(/^SNK-/);
      expect(order.totalAmount).toBe(4_990_000 * 2 + 2_929_000);
      expect(order.items).toHaveLength(2);
      expect(order.items[0]!.shoe.brand.name).toBe("Nike");

      // Stock decreased for both shoes (Jordan: 3 -> 1, AF1: 15 -> 14)
      const afterJordan = (await (
        await app.fetch(new Request(`http://localhost/shoes/${jordan.id}`))
      ).json()) as { stock: number };
      expect(afterJordan.stock).toBe(1);

      // 7. Ordering more than remaining stock rolls back the whole transaction (400)
      const outOfStockRes = await app.fetch(
        new Request("http://localhost/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customerName: "Tran Thi B",
            customerPhone: "0909888999",
            items: [
              { shoeId: af1.id, quantity: 1 },
              { shoeId: jordan.id, quantity: 2 },
            ],
          }),
        }),
      );
      expect(outOfStockRes.status).toBe(400);

      // AF1 stock MUST still be 14 (rolled back!)
      const afterRollbackAf1 = (await (
        await app.fetch(new Request(`http://localhost/shoes/${af1.id}`))
      ).json()) as { stock: number };
      expect(afterRollbackAf1.stock).toBe(14);

      // 8. Confirm order & check sales summary
      const statusRes = await app.fetch(
        new Request(`http://localhost/orders/${order.id}/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "CONFIRMED" }),
        }),
      );
      expect(statusRes.status).toBe(200);

      const statsRes = await app.fetch(new Request("http://localhost/orders/stats"));
      expect(statsRes.status).toBe(200);
      expect(await statsRes.json()).toEqual({
        totalOrders: 1,
        totalPairsSold: 3,
        totalRevenue: 4_990_000 * 2 + 2_929_000,
      });
    } finally {
      await app.close();
    }
  });
});
