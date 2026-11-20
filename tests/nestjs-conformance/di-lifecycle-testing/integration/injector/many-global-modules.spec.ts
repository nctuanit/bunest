import "reflect-metadata";
import { expect } from "bun:test";
import {
  Global,
  Inject,
  Injectable,
  Module,
  Scope,
} from "../../../../../packages/common/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  spyOnMethod,
} from "../../../_helpers";

@Global()
@Module({})
class GlobalModule1 {}

@Global()
@Module({})
class GlobalModule2 {}

@Global()
@Module({})
class GlobalModule3 {}

@Global()
@Module({})
class GlobalModule4 {}

@Global()
@Module({})
class GlobalModule5 {}

@Global()
@Module({})
class GlobalModule6 {}

@Global()
@Module({})
class GlobalModule7 {}

@Global()
@Module({})
class GlobalModule8 {}

@Global()
@Module({})
class GlobalModule9 {}

@Global()
@Module({})
class GlobalModule10 {}

@Injectable()
class TransientProvider {}

@Injectable()
class RequestProvider {}

@Injectable()
class ForeignTransientProvider {}

@Injectable()
class Dependant {
  constructor(
    private readonly transientProvider: TransientProvider,
    private readonly foreignTransientProvider: ForeignTransientProvider,
    @Inject(RequestProvider)
    private readonly requestProvider: RequestProvider,
  ) {}

  public checkDependencies() {
    expect(this.transientProvider).toBeInstanceOf(TransientProvider);
    expect(this.foreignTransientProvider).toBeInstanceOf(
      ForeignTransientProvider,
    );
    expect(this.requestProvider).toBeInstanceOf(RequestProvider);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: ForeignTransientProvider,
      scope: Scope.TRANSIENT,
      useClass: ForeignTransientProvider,
    },
  ],
  exports: [ForeignTransientProvider],
})
class ModuleWithForeignTransientProvider {}

@Global()
@Module({
  providers: [
    {
      provide: RequestProvider,
      scope: Scope.REQUEST,
      useFactory: () => new RequestProvider(),
    },
  ],
  exports: [RequestProvider],
})
class GlobalModuleWithRequestProvider {}

const sharedGlobalImports = [
  ModuleWithForeignTransientProvider,
  GlobalModule1,
  GlobalModule2,
  GlobalModule3,
  GlobalModule4,
  GlobalModule5,
  GlobalModule6,
  GlobalModule7,
  GlobalModule8,
  GlobalModule9,
  GlobalModule10,
];

describeConformance(
  "Many global modules",
  {
    upstreamPath: "integration/injector/e2e/many-global-modules.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-012"],
    notes:
      "Upstream uses Scope.DEFAULT on Dependant and relies on implicit request-scope bubbling; Bunest rejects singleton->request leaks at bootstrap (ADR-012) and resolves cleanly when Dependant explicitly opts into Scope.REQUEST.",
  },
  () => {
    itAdapted(
      "ADR-012",
      "should throw ScopeLeakException when singleton Dependant injects a request-scoped global provider",
      async () => {
        @Global()
        @Module({
          providers: [
            {
              provide: TransientProvider,
              scope: Scope.TRANSIENT,
              useClass: TransientProvider,
            },
            {
              provide: Dependant,
              scope: Scope.SINGLETON,
              useClass: Dependant,
            },
          ],
        })
        class GlobalModuleWithSingletonDependant {}

        @Module({
          imports: [
            ...sharedGlobalImports,
            GlobalModuleWithSingletonDependant,
            GlobalModuleWithRequestProvider,
          ],
        })
        class LeakingAppModule {}

        await expectScopeLeak(() =>
          Test.createTestingModule({
            imports: [LeakingAppModule],
          }).compile(),
        );
      },
    );

    itAdapted(
      "ADR-012",
      "should inject request-scoped and transient-scoped providers from different global modules when Dependant declares Scope.REQUEST",
      async () => {
        @Global()
        @Module({
          providers: [
            {
              provide: TransientProvider,
              scope: Scope.TRANSIENT,
              useClass: TransientProvider,
            },
            {
              provide: Dependant,
              scope: Scope.REQUEST,
              useClass: Dependant,
            },
          ],
        })
        class GlobalModuleWithRequestDependant {}

        @Module({
          imports: [
            ...sharedGlobalImports,
            GlobalModuleWithRequestDependant,
            GlobalModuleWithRequestProvider,
          ],
        })
        class AppModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        const dependant = await moduleRef.resolve(Dependant);
        const checkDependenciesSpy = spyOnMethod(
          dependant,
          "checkDependencies",
        );
        dependant.checkDependencies();

        expect(checkDependenciesSpy).toHaveBeenCalled();
        await moduleRef.close();
      },
    );
  },
);
