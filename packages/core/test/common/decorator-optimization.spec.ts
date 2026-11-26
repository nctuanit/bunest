import { describe, expect, it } from "bun:test";
import {
  ClassMetadataStore,
  createMetadataKey,
  getCachedInheritanceChain,
} from "../../src/common";

describe("Decorator Optimization Foundations (Pillar 2)", () => {
  describe("createMetadataKey<T>", () => {
    it("supports replace, append (copy-on-write inheritance), merge, and reusable decorators", () => {
      const TagsKey = createMetadataKey<readonly string[]>("test:tags", {
        merge: "append",
      });
      const ConfigKey = createMetadataKey<{ retries?: number; timeout?: number }>(
        "test:cfg",
        { merge: "merge" },
      );
      const LabelKey = createMetadataKey<string>("test:label");

      @TagsKey.decorator(["base"])
      @ConfigKey.decorator({ retries: 2, timeout: 1000 })
      @LabelKey.decorator("BaseLabel")
      class BaseService {}

      @TagsKey.decorator(["child"])
      @ConfigKey.decorator({ timeout: 5000 })
      @LabelKey.decorator("ChildLabel")
      class ChildService extends BaseService {}

      // Copy-on-write: BaseService must NEVER be mutated by ChildService
      expect(TagsKey.getOwn(BaseService)).toEqual(["base"]);
      expect(TagsKey.getOwn(ChildService)).toEqual(["base", "child"]);
      expect(ConfigKey.getOwn(BaseService)).toEqual({
        retries: 2,
        timeout: 1000,
      });
      expect(ConfigKey.getOwn(ChildService)).toEqual({
        retries: 2,
        timeout: 5000,
      });
      expect(LabelKey.get(BaseService)).toBe("BaseLabel");
      expect(LabelKey.get(ChildService)).toBe("ChildLabel");
      expect(LabelKey.hasOwn(ChildService)).toBe(true);
    });
  });

  describe("ClassMetadataStore<TBucket>", () => {
    it("provides single-realm inheritance-ordered buckets with version tracking and snapshot/restore", () => {
      interface DemoBucket {
        items: string[];
      }

      const key = `test:class_store:${crypto.randomUUID()}`;
      const storeA = new ClassMetadataStore<DemoBucket>(key, () => ({
        items: [],
      }));
      const storeB = new ClassMetadataStore<DemoBucket>(key, () => ({
        items: [],
      }));

      class GrandParent {}
      class Parent extends GrandParent {}
      class Child extends Parent {}

      const v0 = storeA.version;
      storeA.getOrCreateOwn(GrandParent).items.push("gp");
      storeB.getOrCreateOwn(Child).items.push("child");
      expect(storeA.version).toBeGreaterThan(v0);

      // Single-realm sharing across instances + cached inheritance chain
      expect(getCachedInheritanceChain(Child)).toEqual([
        GrandParent,
        Parent,
        Child,
      ]);
      expect(
        storeA.getInheritanceBuckets(Child).flatMap((b) => b.items),
      ).toEqual(["gp", "child"]);

      const snap = storeA.snapshot();
      storeA.clear();
      expect(storeA.getRegisteredClasses()).toHaveLength(0);
      expect(storeA.getOwn(Child)).toBeUndefined();

      storeA.restore(snap);
      expect(storeA.getRegisteredClasses()).toContain(Child);
      expect(storeA.getOwn(Child)?.items).toEqual(["child"]);
    });
  });
});
