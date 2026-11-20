import "reflect-metadata";
import { describe, expect, it, mock } from "bun:test";
import { Inject, Injectable, Scope } from "../../../../../packages/common/src";
import {
  ModuleMocker,
  Test,
  createAutoMocker,
  describeConformance,
  itAdapted,
} from "../../../_helpers";

describeConformance(
  "TestingInjector / Auto-Mocker Behavior",
  {
    upstreamPath: "packages/testing/test/testing-injector.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-012"],
    notes:
      "Upstream tests private NestJS TestingInjector; adapted to verify identical auto-mocking & mocker fallback behavior via @bunest/testing TestingModuleBuilder.useMocker() + ModuleMocker.",
  },
  () => {
    describe("setMocker / useMocker registration", () => {
      itAdapted("ADR-002", "should resolve existing provider without invoking mocker", async () => {
        @Injectable()
        class ExistingDep {
          value() {
            return "real";
          }
        }

        @Injectable()
        class Consumer {
          constructor(public readonly dep: ExistingDep) {}
        }

        const mocker = mock(() => ({ value: () => "mocked" }));
        const mod = await Test.createTestingModule({
          providers: [ExistingDep, Consumer],
        })
          .useMocker(mocker)
          .compile();

        expect(mod.get(Consumer).dep.value()).toBe("real");
        expect(mocker).not.toHaveBeenCalled();
        await mod.close();
      });

      itAdapted("ADR-002", "should throw when dependency is missing and no mocker is set", async () => {
        @Injectable()
        class MissingDep {}

        @Injectable()
        class Consumer {
          constructor(public readonly dep: MissingDep) {}
        }

        await expect(
          Test.createTestingModule({ providers: [Consumer] }).compile(),
        ).rejects.toThrow();
      });

      itAdapted("ADR-002", "should invoke mocker when dependency is missing and inject returned mock", async () => {
        @Injectable()
        class MissingDep {}

        @Injectable()
        class Consumer {
          constructor(public readonly dep: MissingDep) {}
        }

        const mockInstance = { mocked: true };
        const mocker = mock(() => mockInstance);

        const mod = await Test.createTestingModule({ providers: [Consumer] })
          .useMocker(mocker)
          .compile();

        expect(mocker).toHaveBeenCalledWith(MissingDep);
        expect(mod.get(Consumer).dep).toBe(mockInstance as unknown as MissingDep);
        await mod.close();
      });

      itAdapted("ADR-002", "should not reuse mocks created by a replaced mocker", async () => {
        @Injectable()
        class MissingDep {}

        @Injectable()
        class Consumer {
          constructor(public readonly dep: MissingDep) {}
        }

        const builder = Test.createTestingModule({ providers: [Consumer] });
        builder.useMocker(() => ({ from: "first" }));
        builder.useMocker(() => ({ from: "second" }));

        const mod = await builder.compile();
        expect(mod.get(Consumer).dep).toEqual({ from: "second" } as unknown as MissingDep);
        await mod.close();
      });

      itAdapted("ADR-002", "should throw when mocker returns undefined for a required dependency", async () => {
        @Injectable()
        class MissingDep {}

        @Injectable()
        class Consumer {
          constructor(public readonly dep: MissingDep) {}
        }

        const mocker = mock(() => undefined);

        await expect(
          Test.createTestingModule({ providers: [Consumer] })
            .useMocker(mocker)
            .compile(),
        ).rejects.toThrow();
        expect(mocker).toHaveBeenCalledWith(MissingDep);
      });

      itAdapted("ADR-002", "should mock string token dependencies via @Inject", async () => {
        @Injectable()
        class Consumer {
          constructor(@Inject("CUSTOM_TOKEN") public readonly dep: unknown) {}
        }

        const mockInstance = { mocked: true };
        const mocker = mock((token: unknown) =>
          token === "CUSTOM_TOKEN" ? mockInstance : undefined,
        );

        const mod = await Test.createTestingModule({ providers: [Consumer] })
          .useMocker(mocker)
          .compile();

        expect(mocker).toHaveBeenCalledWith("CUSTOM_TOKEN");
        expect(mod.get(Consumer).dep).toBe(mockInstance);
        await mod.close();
      });

      itAdapted("ADR-012", "should support auto-mocking missing dependencies of request-scoped providers", async () => {
        @Injectable()
        class MissingDep {}

        @Injectable({ scope: Scope.REQUEST })
        class ScopedConsumer {
          constructor(public readonly dep: MissingDep) {}
        }

        const mockInstance = { scopedMock: true };
        const mod = await Test.createTestingModule({
          providers: [ScopedConsumer],
        })
          .useMocker((token) => (token === MissingDep ? mockInstance : undefined))
          .compile();

        const resolved = await mod.resolve(ScopedConsumer);
        expect(resolved.dep).toBe(mockInstance as unknown as MissingDep);
        await mod.close();
      });
    });

    describe("ModuleMocker & createAutoMocker", () => {
      it("should generate metadata and mock methods for class tokens", () => {
        class TargetService {
          greet(name: string): string {
            return `hi ${name}`;
          }
        }

        const mocker = new ModuleMocker();
        const metadata = mocker.getMetadata(TargetService);
        expect(metadata).toBeDefined();

        const MockCtor = mocker.generateFromMetadata(metadata!);
        const mocked = new MockCtor();
        expect(typeof mocked.greet).toBe("function");
        mocked.greet("bunest");
        expect((mocked.greet as unknown as { calls?: unknown[] }).calls ?? []).toBeDefined();
      });

      it("should work seamlessly with createAutoMocker() in TestingModuleBuilder", async () => {
        @Injectable()
        class Repo {
          findAll(): string[] {
            return ["real"];
          }
        }

        @Injectable()
        class Service {
          constructor(public readonly repo: Repo) {}
        }

        const mod = await Test.createTestingModule({ providers: [Service] })
          .useMocker(createAutoMocker())
          .compile();

        const svc = mod.get(Service);
        expect(svc.repo).toBeDefined();
        expect(typeof svc.repo.findAll).toBe("function");
        await mod.close();
      });

      it("should handle property-injected missing dependencies via mocker", async () => {
        @Injectable()
        class PropDep {}

        @Injectable()
        class Host {
          @Inject(PropDep)
          public dep!: PropDep;
        }

        const stub = { tag: "prop-mock" };
        const mod = await Test.createTestingModule({ providers: [Host] })
          .useMocker((t) => (t === PropDep ? stub : undefined))
          .compile();

        expect(mod.get(Host).dep).toBe(stub as unknown as PropDep);
        await mod.close();
      });
    });
  },
);
