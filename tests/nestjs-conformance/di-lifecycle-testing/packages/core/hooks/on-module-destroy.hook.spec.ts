import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { OnModuleDestroy } from "../../../../../../packages/core/src/common";
import { LifecycleManager } from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

class SampleProvider implements OnModuleDestroy {
  onModuleDestroy() {}
}

class SampleModule implements OnModuleDestroy {
  onModuleDestroy() {}
}

class WithoutHookProvider {}

describeConformance(
  "OnModuleDestroy",
  {
    upstreamPath: "packages/core/test/hooks/on-module-destroy.hook.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007"],
    notes:
      "Upstream tests internal callModuleDestroyHook(); adapted to @bunest/core LifecycleManager.callShutdown().",
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

    const sampleModMeta = { id: "sample", name: "SampleModule" };

    describe("callShutdown (onModuleDestroy phase)", () => {
      itAdapted(
        "ADR-007",
        'should call "onModuleDestroy" hook for the entire module',
        async () => {
          const hookSpy = spyOn(sampleProvider, "onModuleDestroy");
          const modSpy = spyOn(sampleModule, "onModuleDestroy");

          await lifecycle.callShutdown([
            {
              module: sampleModMeta,
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

      itAdapted(
        "ADR-007",
        "should call remaining providers even when one onModuleDestroy throws",
        async () => {
          class FailingProvider implements OnModuleDestroy {
            async onModuleDestroy() {
              throw new Error("cleanup error");
            }
          }
          const successHook = mock(() => {});
          class SuccessProvider implements OnModuleDestroy {
            onModuleDestroy = successHook;
          }

          await expect(
            lifecycle.callShutdown([
              {
                module: sampleModMeta,
                instances: [
                  sampleModule,
                  new SuccessProvider(),
                  new FailingProvider(),
                ],
              },
            ]),
          ).rejects.toThrow("cleanup error");

          expect(successHook).toHaveBeenCalledTimes(1);
        },
      );

      itAdapted(
        "ADR-007",
        "should propagate rejection when a provider onModuleDestroy rejects",
        async () => {
          class RejectingProvider implements OnModuleDestroy {
            async onModuleDestroy() {
              throw new Error("cleanup error");
            }
          }

          await expect(
            lifecycle.callShutdown([
              {
                module: sampleModMeta,
                instances: [sampleModule, new RejectingProvider()],
              },
            ]),
          ).rejects.toThrow("cleanup error");
        },
        "ADR-007: callShutdown() aggregates and rethrows shutdown hook failures",
      );

      itAdapted(
        "ADR-007",
        "should propagate rejection when the module class instance hook rejects",
        async () => {
          const rejectingModule = {
            onModuleDestroy: mock(() =>
              Promise.reject(new Error("module error")),
            ),
          };

          await expect(
            lifecycle.callShutdown([
              {
                module: sampleModMeta,
                instances: [rejectingModule, sampleProvider],
              },
            ]),
          ).rejects.toThrow("module error");
        },
        "ADR-007: callShutdown() aggregates and rethrows shutdown hook failures",
      );
    });
  },
);
