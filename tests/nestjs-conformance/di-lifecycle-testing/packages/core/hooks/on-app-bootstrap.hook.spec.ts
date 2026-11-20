import "reflect-metadata";
import { beforeEach, describe, expect, spyOn } from "bun:test";
import type { OnApplicationBootstrap } from "../../../../../../packages/common/src";
import { LifecycleManager } from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

class SampleProvider implements OnApplicationBootstrap {
  onApplicationBootstrap() {}
}

class SampleModule implements OnApplicationBootstrap {
  onApplicationBootstrap() {}
}

class WithoutHookProvider {}

describeConformance(
  "OnApplicationBootstrap",
  {
    upstreamPath: "packages/core/test/hooks/on-app-bootstrap.hook.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007"],
    notes:
      "Upstream tests internal callModuleBootstrapHook(); adapted to @bunest/core LifecycleManager.callApplicationBootstrap().",
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

    describe("callApplicationBootstrap", () => {
      itAdapted(
        "ADR-007",
        'should call "onApplicationBootstrap" hook for the entire module',
        async () => {
          const hookSpy = spyOn(sampleProvider, "onApplicationBootstrap");
          const modSpy = spyOn(sampleModule, "onApplicationBootstrap");

          await lifecycle.callApplicationBootstrap([
            {
              module: { id: "sample", name: "SampleModule" },
              instances: [sampleModule, sampleProvider, new WithoutHookProvider()],
            },
          ]);

          expect(hookSpy).toHaveBeenCalledTimes(1);
          expect(modSpy).toHaveBeenCalledTimes(1);
        },
      );
    });
  },
);
