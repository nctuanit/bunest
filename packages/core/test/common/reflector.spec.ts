import { describe, expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  Reflector,
  SetMetadata,
} from "../../src/common";

describe("Reflector & MetadataRegistry", () => {
  const reflector = new Reflector();

  it("marks Reflector as injectable", () => {
    expect(MetadataRegistry.has(METADATA_KEYS.INJECTABLE, Reflector)).toBe(
      true,
    );
  });

  it("supports get, getAll, getAllAndMerge, and getAllAndOverride", () => {
    const Roles = Reflector.createDecorator<string[]>();
    const Config = Reflector.createDecorator<Record<string, unknown>>({
      key: "custom:config",
    });
    const UpperTag = Reflector.createDecorator<string, string>({
      transform: (v) => v.toUpperCase(),
    });

    @Roles(["user"])
    @Config({ timeout: 1000, retries: 1 })
    @SetMetadata("public", false)
    class SampleController {
      @Roles(["admin", "editor"])
      @Config({ retries: 3, cache: true })
      @SetMetadata("public", true)
      @UpperTag("critical")
      action() {}

      @SetMetadata("only-method", "yes")
      fallback() {}
    }

    const action = SampleController.prototype.action;
    const fallback = SampleController.prototype.fallback;

    // get
    expect(reflector.get(Roles, SampleController)).toEqual(["user"]);
    expect(reflector.get(Roles, action)).toEqual(["admin", "editor"]);
    expect(reflector.get(UpperTag, action)).toBe("CRITICAL");

    // getAll
    expect(
      reflector.getAll(Roles, [action, SampleController, undefined]),
    ).toEqual([["admin", "editor"], ["user"], undefined]);

    // getAllAndMerge for arrays (non-mutating)
    const mergedRoles = reflector.getAllAndMerge(Roles, [
      SampleController,
      action,
    ]);
    expect(mergedRoles).toEqual(["user", "admin", "editor"]);
    expect(reflector.get(Roles, SampleController)).toEqual(["user"]);

    // getAllAndMerge for objects (later overrides earlier)
    const mergedConfig = reflector.getAllAndMerge(Config, [
      SampleController,
      action,
    ]);
    expect(mergedConfig).toEqual({ timeout: 1000, retries: 3, cache: true });

    // getAllAndMerge when empty returns []
    expect(
      reflector.getAllAndMerge("missing", [action, SampleController]),
    ).toEqual([]);

    // getAllAndOverride: first defined target wins
    expect(
      reflector.getAllAndOverride<boolean>("public", [
        action,
        SampleController,
      ]),
    ).toBe(true);
    expect(
      reflector.getAllAndOverride<boolean>("public", [
        fallback,
        SampleController,
      ]),
    ).toBe(false);
    expect(
      reflector.getAllAndOverride("nonexistent", [action, SampleController]),
    ).toBeUndefined();
  });

  it("supports MetadataRegistry CRUD operations cleanly", () => {
    const key = Symbol("test:crud");
    class Target {}

    expect(MetadataRegistry.has(key, Target)).toBe(false);
    MetadataRegistry.define(key, { ok: true }, Target);
    expect(MetadataRegistry.has(key, Target)).toBe(true);
    expect(MetadataRegistry.hasOwn(key, Target)).toBe(true);
    expect(MetadataRegistry.get(key, Target)).toEqual({ ok: true });
    expect(MetadataRegistry.getOwnKeys(Target)).toContain(key);
    expect(MetadataRegistry.delete(key, Target)).toBe(true);
    expect(MetadataRegistry.has(key, Target)).toBe(false);
  });
});
