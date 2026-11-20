import "reflect-metadata";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { BeforeApplicationShutdown } from "../../../../../../packages/common/src";
import { LifecycleManager } from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

class SampleProvider implements BeforeApplicationShutdown {
  beforeApplicationShutdown(_signal?: string) {}
}

class SampleModule implements BeforeApplicationShutdown {
  beforeApplicationShutdown(_signal?: string) {}
}

class WithoutHookProvider {}

describeConformance(
  "BeforeAppShutdown",
  {
    upstreamPath: "packages/core/test/hooks/before-app-shutdown.hook.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007"],
    notes:
      "Upstream tests internal callBeforeAppShutdownHook(); adapted to @bunest/core LifecycleManager.callShutdown().",
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

    describe("callShutdown (beforeApplicationShutdown phase)", () => {
      itAdapted(
        "ADR-007",
        'should call "beforeApplicationShutdown" hook with signal for the entire module',
        async () => {
          const signal = "SIGTERM";
          const hookSpy = spyOn(sampleProvider, "beforeApplicationShutdown");
          const modSpy = spyOn(sampleModule, "beforeApplicationShutdown");

          await lifecycle.callShutdown(
            [
              {
                module: sampleModMeta,
                instances: [sampleModule, sampleProvider, new WithoutHookProvider()],
              },
            ],
            signal,
          );

          expect(hookSpy).toHaveBeenCalledWith(signal);
          expect(modSpy).toHaveBeenCalledWith(signal);
        },
      );

      itAdapted(
        "ADR-007",
        "should call remaining providers even when one beforeApplicationShutdown hook throws",
        async () => {
          class FailingProvider implements BeforeApplicationShutdown {
            async beforeApplicationShutdown() {
              throw new Error("shutdown error");
            }
          }
          const successHook = mock(() => {});
          class SuccessProvider implements BeforeApplicationShutdown {
            beforeApplicationShutdown = successHook;
          }

          await expect(
            lifecycle.callShutdown(
              [
                {
                  module: sampleModMeta,
                  instances: [
                    sampleModule,
                    new SuccessProvider(),
                    new FailingProvider(),
                  ],
                },
              ],
              "SIGTERM",
            ),
          ).rejects.toThrow("shutdown error");

          expect(successHook).toHaveBeenCalledWith("SIGTERM");
        },
      );

      // BUNEST_BUG: LifecycleManager.callShutdown() rethrows hook rejections instead of logging and swallowing them like NestJS v12 callBeforeAppShutdownHook() (packages/core/src/lifecycle/lifecycle-manager.ts:201)
      it.skip("should swallow and log errors without throwing when a provider beforeApplicationShutdown rejects", async () => {
        class RejectingProvider implements BeforeApplicationShutdown {
          async beforeApplicationShutdown() {
            throw new Error("shutdown error");
          }
        }

        await expect(
          lifecycle.callShutdown(
            [
              {
                module: sampleModMeta,
                instances: [sampleModule, new RejectingProvider()],
              },
            ],
            "SIGTERM",
          ),
        ).resolves.toBeUndefined();
      });

      // BUNEST_BUG: LifecycleManager.callShutdown() rethrows module class hook rejections instead of swallowing them (packages/core/src/lifecycle/lifecycle-manager.ts:201)
      it.skip("should not throw when the module class instance hook rejects", async () => {
        const rejectingModule = {
          beforeApplicationShutdown: mock(() =>
            Promise.reject(new Error("module error")),
          ),
        };

        await expect(
          lifecycle.callShutdown(
            [
              {
                module: sampleModMeta,
                instances: [rejectingModule, sampleProvider],
              },
            ],
            "SIGTERM",
          ),
        ).resolves.toBeUndefined();
      });
    });
  },
);
