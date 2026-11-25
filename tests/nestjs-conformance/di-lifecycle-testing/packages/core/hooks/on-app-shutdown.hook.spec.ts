import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { OnApplicationShutdown } from "../../../../../../packages/core/src/common";
import { LifecycleManager } from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

class SampleProvider implements OnApplicationShutdown {
  onApplicationShutdown(_signal?: string) {}
}

class SampleModule implements OnApplicationShutdown {
  onApplicationShutdown(_signal?: string) {}
}

class WithoutHookProvider {}

describeConformance(
  "OnApplicationShutdown",
  {
    upstreamPath: "packages/core/test/hooks/on-app-shutdown.hook.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007"],
    notes:
      "Upstream tests internal callAppShutdownHook(); adapted to @bunest/core LifecycleManager.callShutdown().",
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

    describe("callShutdown (onApplicationShutdown phase)", () => {
      itAdapted(
        "ADR-007",
        'should call "onApplicationShutdown" hook for the entire module',
        async () => {
          const hookSpy = spyOn(sampleProvider, "onApplicationShutdown");
          const modSpy = spyOn(sampleModule, "onApplicationShutdown");

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
        "should call remaining providers even when one onApplicationShutdown hook throws",
        async () => {
          class FailingProvider implements OnApplicationShutdown {
            async onApplicationShutdown() {
              throw new Error("shutdown error");
            }
          }
          const successHook = mock(() => {});
          class SuccessProvider implements OnApplicationShutdown {
            onApplicationShutdown = successHook;
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
          ).rejects.toThrow("shutdown error");

          expect(successHook).toHaveBeenCalledTimes(1);
        },
      );

      itAdapted(
        "ADR-007",
        "should propagate rejection when a provider onApplicationShutdown rejects",
        async () => {
          class RejectingProvider implements OnApplicationShutdown {
            async onApplicationShutdown() {
              throw new Error("shutdown error");
            }
          }

          await expect(
            lifecycle.callShutdown([
              {
                module: sampleModMeta,
                instances: [sampleModule, new RejectingProvider()],
              },
            ]),
          ).rejects.toThrow("shutdown error");
        },
        "ADR-007: callShutdown() aggregates and rethrows shutdown hook failures",
      );

      itAdapted(
        "ADR-007",
        "should propagate rejection when the module class instance hook rejects",
        async () => {
          const rejectingModule = {
            onApplicationShutdown: mock(() =>
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
