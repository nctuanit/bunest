import { describe, expect, it } from "bun:test";
import {
  ClassMetadataStore,
  Data,
  NonNull,
  Secret,
  createMetadataKey,
  getCachedInheritanceChain,
  getCompiledMacroPlan,
  invalidateMacroPlanCache,
  registerCompiledMacroPlan,
  resetGlobalMacroDefaults,
  setGlobalMacroDefaults,
} from "../../src/common";

describe("Decorator Optimization Foundations (Pillar 2 & Pillar 3)", () => {
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

  describe("CompiledMacroPlan WeakMap Cache & AOT skipProbe", () => {
    it("caches compiled macro plans and avoids repeated constructor probing across equals/hashCode/toString/toJSON", () => {
      let ctorCalls = 0;

      @Data()
      class TrackedModel {
        id = 1;
        @NonNull()
        name = "ada";
        @Secret()
        token = "secret-xyz";

        constructor() {
          ctorCalls += 1;
        }
      }

      const callsAfterDecorate = ctorCalls;
      const plan1 = getCompiledMacroPlan(TrackedModel);
      const plan2 = getCompiledMacroPlan(TrackedModel);
      expect(plan2).toBe(plan1);
      expect(ctorCalls).toBe(callsAfterDecorate);
      expect(plan1.nonNullFields.map((f) => f.field)).toEqual(["name"]);
      expect(plan1.baseKnownFields).toEqual(
        expect.arrayContaining(["id", "name", "token"]),
      );

      // Calling hot-path macro methods repeatedly should NOT probe `new TrackedModel()` again
      const a = Object.assign(Object.create(TrackedModel.prototype), {
        id: 1,
        name: "ada",
        token: "secret-xyz",
      }) as any;
      const b = Object.assign(Object.create(TrackedModel.prototype), {
        id: 1,
        name: "ada",
        token: "secret-xyz",
      }) as any;

      for (let i = 0; i < 20; i++) {
        expect(a.equals(b)).toBe(true);
        expect(a.hashCode()).toBe(b.hashCode());
        expect(a.toString()).toBe("TrackedModel(name=ada, token=***, id=1)");
        expect(a.toJSON()).toEqual({ id: 1, name: "ada" });
      }
      expect(ctorCalls).toBe(callsAfterDecorate);

      // Global default mutation invalidates cache version cleanly
      const prevVersion = plan1.version;
      setGlobalMacroDefaults({ toString: { maskValue: "REDACTED" } });
      try {
        const plan3 = getCompiledMacroPlan(TrackedModel);
        expect(plan3.version).toBeGreaterThan(prevVersion);
      } finally {
        resetGlobalMacroDefaults();
      }
    });

    it("supports registerCompiledMacroPlan({ skipProbe: true }) for zero-constructor-probe AOT startup", () => {
      let probed = 0;

      class AotModel {
        email!: string;
        age!: number;
        constructor() {
          probed += 1;
        }
      }

      const plan = registerCompiledMacroPlan(AotModel, {
        fields: ["email", "age"],
        skipProbe: true,
      });
      expect(probed).toBe(0);
      expect(plan.baseKnownFields).toEqual(["email", "age"]);

      invalidateMacroPlanCache(AotModel);
      const recomputed = getCompiledMacroPlan(AotModel);
      expect(probed).toBe(0);
      expect(recomputed.baseKnownFields).toEqual(["email", "age"]);
    });
  });
});
