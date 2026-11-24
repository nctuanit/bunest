import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Logger,
  Module,
  Scope,
} from "../../../../../packages/core/src/common";
import { ModuleRef, REQUEST } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  type TestingModule,
} from "../../../_helpers";

const STATIC_FACTORY = "STATIC_FACTORY";

@Injectable({ scope: Scope.REQUEST })
class ScopedService {
  constructor(@Inject(REQUEST) public readonly request: unknown) {}
}

@Injectable({ scope: Scope.TRANSIENT })
class Transient2Service {
  logger = new Logger();
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientService {
  constructor(public readonly svc: Transient2Service) {}
}

@Module({
  providers: [
    ScopedService,
    TransientService,
    Transient2Service,
    {
      provide: STATIC_FACTORY,
      useFactory: () => true,
    },
  ],
})
class ScopedModule {}

describeConformance(
  "Providers introspection",
  {
    upstreamPath: "integration/injector/e2e/introspection.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-012"],
    notes:
      "Bunest Scope enum uses Scope.SINGLETON (aliased/equivalent to NestJS Scope.DEFAULT).",
  },
  () => {
    let testingModule: TestingModule;
    let moduleRef: ModuleRef;

    beforeEach(async () => {
      testingModule = await Test.createTestingModule({
        imports: [ScopedModule],
      }).compile();
      moduleRef = testingModule.get(ModuleRef);
    });

    afterEach(async () => {
      await testingModule.close();
    });

    it("should properly introspect a transient provider", () => {
      const introspectionResult = moduleRef.introspect(TransientService);
      expect(introspectionResult.scope).toBe(Scope.TRANSIENT);
    });

    it("should properly introspect a singleton provider", () => {
      const introspectionResult = moduleRef.introspect(STATIC_FACTORY);
      expect(introspectionResult.scope).toBe(Scope.SINGLETON);
    });

    it("should properly introspect a request-scoped provider", () => {
      const introspectionResult = moduleRef.introspect(ScopedService);
      expect(introspectionResult.scope).toBe(Scope.REQUEST);
    });
  },
);
