import { describe, expect, it } from "bun:test";
import {
  REFLECT_METADATA_STORE_SYMBOL,
  createReflectMetadataApi,
  getReflectMetadataStore,
  installReflectMetadataShim,
  type ReflectMetadataApi,
} from "../../src/common/metadata/reflect-shim";

describe("Zero-Dep Reflect Metadata Shim", () => {
  it("stores metadata in the single-realm Symbol.for('bunest:reflect:metadata') WeakMap", () => {
    const store = getReflectMetadataStore();
    expect(store).toBeInstanceOf(WeakMap);
    expect(
      (globalThis as Record<PropertyKey, unknown>)[
        REFLECT_METADATA_STORE_SYMBOL
      ],
    ).toBe(store);
  });

  it("installs all 10 Reflect metadata methods idempotently without overwriting existing methods", () => {
    const target: Record<string, unknown> = {};
    const customDefine = () => "existing";
    target.defineMetadata = customDefine;

    installReflectMetadataShim(target);

    // Existing method preserved (idempotent)
    expect(target.defineMetadata).toBe(customDefine);
    // Remaining 9 methods installed as non-enumerable functions
    for (const method of [
      "getMetadata",
      "getOwnMetadata",
      "hasMetadata",
      "hasOwnMetadata",
      "deleteMetadata",
      "getMetadataKeys",
      "getOwnMetadataKeys",
      "metadata",
      "decorate",
    ]) {
      expect(typeof target[method]).toBe("function");
      expect(Object.keys(target)).not.toContain(method);
    }

    // Second installation is a no-op
    const prevGet = target.getMetadata;
    installReflectMetadataShim(target);
    expect(target.getMetadata).toBe(prevGet);
  });

  it("implements defineMetadata, getMetadata, getOwnMetadata, hasMetadata, hasOwnMetadata, and deleteMetadata across prototype chains", () => {
    const api = createReflectMetadataApi(new WeakMap());

    class Base {
      greet() {}
    }
    class Child extends Base {}

    const SYM_KEY = Symbol("custom");
    const PROP_SYM = Symbol("prop");

    // Class-level inheritance
    api.defineMetadata("role", "base-role", Base);
    api.defineMetadata("inheritedOnly", 42, Base);
    api.defineMetadata("shadowUndefined", "parent-val", Base);
    api.defineMetadata("role", "child-role", Child);
    api.defineMetadata("shadowUndefined", undefined, Child);
    api.defineMetadata(SYM_KEY, { ok: true }, Base, PROP_SYM);

    expect(api.hasOwnMetadata("role", Base)).toBe(true);
    expect(api.hasOwnMetadata("role", Child)).toBe(true);
    expect(api.hasOwnMetadata("inheritedOnly", Child)).toBe(false);
    expect(api.hasMetadata("inheritedOnly", Child)).toBe(true);

    expect(api.getOwnMetadata("role", Base)).toBe("base-role");
    expect(api.getOwnMetadata("role", Child)).toBe("child-role");
    expect(api.getMetadata("role", Child)).toBe("child-role");
    expect(api.getOwnMetadata("inheritedOnly", Child)).toBeUndefined();
    expect(api.getMetadata("inheritedOnly", Child)).toBe(42);

    // Explicit `undefined` on Child shadows parent's value
    expect(api.hasOwnMetadata("shadowUndefined", Child)).toBe(true);
    expect(api.getMetadata("shadowUndefined", Child)).toBeUndefined();

    // Symbol metadata key + symbol property key
    expect(api.hasMetadata(SYM_KEY, Child, PROP_SYM)).toBe(true);
    expect(api.getMetadata(SYM_KEY, Child, PROP_SYM)).toEqual({ ok: true });
    expect(api.hasOwnMetadata(SYM_KEY, Child, PROP_SYM)).toBe(false);

    // Prototype method-level inheritance
    api.defineMetadata("http:method", "GET", Base.prototype, "greet");
    expect(api.getMetadata("http:method", Child.prototype, "greet")).toBe(
      "GET",
    );
    expect(
      api.getOwnMetadata("http:method", Child.prototype, "greet"),
    ).toBeUndefined();

    // deleteMetadata only deletes own metadata
    expect(api.deleteMetadata("inheritedOnly", Child)).toBe(false);
    expect(api.deleteMetadata("role", Child)).toBe(true);
    expect(api.deleteMetadata("role", Child)).toBe(false);
    expect(api.getMetadata("role", Child)).toBe("base-role");
  });

  it("preserves insertion order and deduplicates in getOwnMetadataKeys and getMetadataKeys", () => {
    const api = createReflectMetadataApi(new WeakMap());

    class GrandParent {}
    class Parent extends GrandParent {}
    class Child extends Parent {}

    api.defineMetadata("a", 1, GrandParent);
    api.defineMetadata("b", 2, GrandParent);
    api.defineMetadata("b", 20, Parent);
    api.defineMetadata("c", 3, Parent);
    api.defineMetadata("d", 4, Child);
    api.defineMetadata("a", 100, Child);

    expect(api.getOwnMetadataKeys(Child)).toEqual(["d", "a"]);
    expect(api.getMetadataKeys(Child)).toEqual(["d", "a", "b", "c"]);
    expect(api.getOwnMetadataKeys(Child, "missing")).toEqual([]);
    expect(api.getMetadataKeys(Child, "missing")).toEqual([]);
  });

  it("implements Reflect.metadata() and Reflect.decorate() with reverse application and descriptor/constructor replacement", () => {
    const api = createReflectMetadataApi(new WeakMap());
    const order: string[] = [];

    // Class decorators
    class Original {
      kind = "original";
    }
    const d1 = (ctor: Function) => {
      order.push("d1");
      api.defineMetadata("d1", true, ctor);
    };
    const d2 = (ctor: Function) => {
      order.push("d2");
      return class Replaced extends (ctor as new () => Original) {
        replaced = true;
      };
    };

    const resultCtor = api.decorate([d1, d2], Original) as new () => {
      kind: string;
      replaced: boolean;
    };
    expect(order).toEqual(["d2", "d1"]);
    expect(resultCtor).not.toBe(Original);
    expect(new resultCtor().replaced).toBe(true);
    expect(api.getOwnMetadata("d1", resultCtor)).toBe(true);

    // Property / method decorators + Reflect.metadata()
    const propOrder: string[] = [];
    const targetObj = {
      compute(x: number) {
        return x + 1;
      },
    };
    const origDesc = Object.getOwnPropertyDescriptor(targetObj, "compute")!;
    const m1 = (
      _t: object,
      _k: PropertyKey,
      desc: PropertyDescriptor,
    ): PropertyDescriptor => {
      propOrder.push("m1");
      const fn = desc.value as (x: number) => number;
      return { ...desc, value: (x: number) => fn(x) * 10 };
    };
    const m2 = api.metadata("tag", "computed");

    const nextDesc = api.decorate(
      [m1, m2],
      targetObj,
      "compute",
      origDesc,
    ) as PropertyDescriptor;
    expect(propOrder).toEqual(["m1"]);
    expect((nextDesc.value as (x: number) => number)(2)).toBe(30);
    expect(api.getOwnMetadata("tag", targetObj, "compute")).toBe("computed");

    // null attributes normalized to undefined (matching TypeScript __decorate)
    let seenDesc: unknown = "unset";
    api.decorate(
      [
        (_t: object, _k: PropertyKey, d: unknown) => {
          seenDesc = d;
        },
      ],
      targetObj,
      "compute",
      null,
    );
    expect(seenDesc).toBeUndefined();
  });

  it("throws TypeError on invalid non-object targets and invalid decorate inputs", () => {
    const api: ReflectMetadataApi = createReflectMetadataApi(new WeakMap());

    expect(() => api.defineMetadata("k", "v", null as unknown as object)).toThrow(
      TypeError,
    );
    expect(() => api.getMetadata("k", 123 as unknown as object)).toThrow(
      TypeError,
    );
    expect(() => api.getOwnMetadata("k", "str" as unknown as object)).toThrow(
      TypeError,
    );
    expect(() => api.hasMetadata("k", undefined as unknown as object)).toThrow(
      TypeError,
    );
    expect(() => api.hasOwnMetadata("k", false as unknown as object)).toThrow(
      TypeError,
    );
    expect(() => api.deleteMetadata("k", null as unknown as object)).toThrow(
      TypeError,
    );
    expect(() => api.getMetadataKeys(null as unknown as object)).toThrow(
      TypeError,
    );
    expect(() => api.getOwnMetadataKeys(null as unknown as object)).toThrow(
      TypeError,
    );
    expect(() =>
      api.decorate("not-array" as unknown as Function[], class {}),
    ).toThrow(TypeError);
    expect(() => api.decorate([], {} as unknown as Function)).toThrow(TypeError);
    expect(() =>
      api.decorate([() => 123 as unknown as Function], class {}),
    ).toThrow(TypeError);
    expect(() =>
      api.decorate([() => 123 as unknown as PropertyDescriptor], {}, "x"),
    ).toThrow(TypeError);
  });

  it("works seamlessly with global Reflect and TypeScript experimental decorators", () => {
    const Dec =
      (label: string): ClassDecorator =>
      (target) => {
        Reflect.defineMetadata("test:label", label, target);
      };

    @Dec("bunest-zero-dep")
    class DemoService {
      constructor(public readonly name: string) {}
    }

    expect(Reflect.getMetadata("test:label", DemoService)).toBe(
      "bunest-zero-dep",
    );
    expect(Reflect.hasMetadata("test:label", DemoService)).toBe(true);
    expect(Reflect.getMetadataKeys(DemoService)).toContain("test:label");
  });
});
