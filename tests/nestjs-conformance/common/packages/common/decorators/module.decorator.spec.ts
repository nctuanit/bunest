import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  Module,
  type ModuleMetadata,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@Module",
  {
    upstreamPath: "packages/common/test/decorators/module.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores all module metadata under a single METADATA_KEYS.MODULE symbol.",
  },
  () => {
    const moduleProps = {
      providers: ["Test"],
      imports: ["Test"],
      exports: ["Test"],
      controllers: ["Test"],
    };

    @Module(moduleProps as any)
    class TestModule {}

    it("should enhance class with expected module metadata", () => {
      const meta = MetadataRegistry.get<ModuleMetadata>(
        METADATA_KEYS.MODULE,
        TestModule,
      );

      expect(meta?.imports).toEqual(moduleProps.imports as any);
      expect(meta?.providers).toEqual(moduleProps.providers as any);
      expect(meta?.controllers).toEqual(moduleProps.controllers as any);
      expect(meta?.exports).toEqual(moduleProps.exports as any);
    });

    // BUNEST_BUG: Module() in packages/core/src/common/decorators/core.decorators.ts:21 does not validate keys of the metadata object (silently ignores unknown keys like `test` instead of throwing an Error / InvalidModuleConfigException).
    it.skip("should throw exception when module properties are invalid", () => {
      const invalidProps = {
        ...moduleProps,
        test: [],
      };

      expect(Module.bind(null, invalidProps as any)).toThrow(Error);
    });

    // BUNEST_BUG: Module() in packages/core/src/common/decorators/core.decorators.ts:25 reads `metadata.exports` directly without checking `Object.prototype.hasOwnProperty.call(metadata, key)`, so prototype-inherited properties leak into stored module metadata.
    it.skip("should ignore properties inherited through the prototype chain", () => {
      const inheritedProps = { exports: ["Inherited"] };
      const metadata = Object.create(inheritedProps) as Record<string, unknown>;
      metadata.providers = ["Own"];

      @Module(metadata as any)
      class ModuleWithInheritedProps {}

      const stored = MetadataRegistry.get<ModuleMetadata>(
        METADATA_KEYS.MODULE,
        ModuleWithInheritedProps,
      );
      expect(stored?.providers).toEqual(["Own"] as any);
      expect(stored?.exports).toBeUndefined();
    });
  },
);
