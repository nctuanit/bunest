import { beforeEach, describe, expect, spyOn } from "bun:test";
import type { OnModuleInit } from "../../../../../../packages/core/src/common";
import { LifecycleManager } from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

class SampleProvider implements OnModuleInit {
  onModuleInit() {}
}

class SampleModule implements OnModuleInit {
  onModuleInit() {}
}

class WithoutHookProvider {}

describeConformance(
  "OnModuleInit",
  {
    upstreamPath: "packages/core/test/hooks/on-module-init.hook.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007"],
    notes:
      "Upstream tests internal callModuleInitHook(); adapted to @bunest/core LifecycleManager.callModuleInit().",
  },
  () => {
    let lifecycle: LifecycleManager;
    let sampleProvider: SampleProvider;
    let sampleModule: SampleModule;

    beforeEach(() => {
      lifecycle = new LifecycleManager();
      sampleProvider = new SampleProvider();
      sampleModule = new SampleModule();
    });

    describe("callModuleInit", () => {
      itAdapted(
        "ADR-007",
        'should call "onModuleInit" hook for the entire module',
        async () => {
          const hookSpy = spyOn(sampleProvider, "onModuleInit");
          const modSpy = spyOn(sampleModule, "onModuleInit");

          await lifecycle.callModuleInit([
            {
              module: { id: "sample", name: "SampleModule" },
              instances: [
                sampleModule,
                sampleProvider,
                new WithoutHookProvider(),
              ],
            },
          ]);

          expect(hookSpy).toHaveBeenCalledTimes(1);
          expect(modSpy).toHaveBeenCalledTimes(1);
        },
      );
    });
  },
);
