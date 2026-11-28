import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";
import { ANCIENT_DRAGON_LOOT } from "../src/heroes/sagas/heroes.sagas";

interface HeroView {
  id: string;
  name: string;
  slainDragons: string[];
  inventory: string[];
}

describe("CQRS Heroes & Dragons (NestJS CQRS E2E)", () => {
  it("executes KillDragonCommand, publishes domain events, triggers Saga DropAncientItemCommand, and queries state", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    const client = mod.createTestClient(app);
    await app.init();

    try {
      // 1. Kill dragon via CommandBus
      const killRes = await client.post("/hero/hero-1/kill", {
        json: { dragonId: "smaug" },
      });
      expect(killRes.status).toBe(201);
      expect(await killRes.json()).toEqual({
        heroId: "hero-1",
        dragonId: "smaug",
      });

      // 2. Query heroes via QueryBus -> Saga automatically dropped ANCIENT_DRAGON_LOOT!
      const heroesRes = await client.get("/hero");
      expect(heroesRes.status).toBe(200);
      const heroes = (await heroesRes.json()) as HeroView[];
      const arthur = heroes.find((h) => h.id === "hero-1");
      expect(arthur).toEqual({
        id: "hero-1",
        name: "Arthur",
        slainDragons: ["smaug"],
        inventory: [ANCIENT_DRAGON_LOOT],
      });

      // 3. Both EventHandlers recorded domain events
      const eventsRes = await client.get("/hero/events");
      expect(eventsRes.status).toBe(200);
      const journal = (await eventsRes.json()) as string[];
      expect(journal).toEqual([
        "Hero hero-1 slew dragon smaug",
        `Hero hero-1 obtained ${ANCIENT_DRAGON_LOOT}`,
      ]);
    } finally {
      await app.close();
    }
  });
});
