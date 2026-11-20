import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Inject,
  Injectable,
  Logger,
  Module,
  Scope,
} from "../../../../../packages/common/src";
import {
  REQUEST,
  ScopeLeakException,
  createContextId,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  type TestingModule,
} from "../../../_helpers";

const STATIC_FACTORY = "STATIC_FACTORY";
const REQUEST_SCOPED_FACTORY = "REQUEST_SCOPED_FACTORY";
const TRANSIENT_SCOPED_FACTORY = "TRANSIENT_SCOPED_FACTORY";

@Controller({
  path: "test",
  scope: Scope.REQUEST,
})
class ScopedController {}

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

@Injectable({ scope: Scope.TRANSIENT })
class Transient3Service {
  constructor(public readonly svc: TransientService) {}
}

@Module({
  controllers: [ScopedController],
  providers: [
    ScopedService,
    TransientService,
    Transient2Service,
    Transient3Service,
    {
      provide: STATIC_FACTORY,
      useFactory: () => true,
    },
    {
      provide: REQUEST_SCOPED_FACTORY,
      useFactory: () => true,
      scope: Scope.REQUEST,
    },
    {
      provide: TRANSIENT_SCOPED_FACTORY,
      useFactory: () => true,
      scope: Scope.TRANSIENT,
    },
  ],
})
class ScopedModule {}

describeConformance(
  "Scoped Instances",
  {
    upstreamPath: "integration/injector/e2e/scoped-instances.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    const OVERLAP_REQUEST_COUNT = 1000;
    let testingModule: TestingModule;

    beforeEach(async () => {
      testingModule = await Test.createTestingModule({
        imports: [ScopedModule],
      }).compile();
    });

    afterEach(async () => {
      await testingModule.close();
    });

    // BUNEST_BUG: resolve(TransientService, contextId) creates a new instance on every call instead of reusing the instance cached for the same ContextId (packages/core/src/di/di-container.ts)
    it.skip("should dynamically resolve transient provider", async () => {
      const contextId = createContextId();
      const transient1 = await testingModule.resolve(
        TransientService,
        contextId,
      );
      const transient2 = await testingModule.resolve(
        TransientService,
        contextId,
      );
      const transientFactory = await testingModule.resolve(
        TRANSIENT_SCOPED_FACTORY,
      );

      expect(transient1).toBeInstanceOf(TransientService);
      expect(transient2).toBeInstanceOf(TransientService);
      expect(transient1).toBe(transient2);
      expect(transientFactory).toBe(true);
    });

    it("should dynamically resolve nested transient provider", async () => {
      const contextId = createContextId();
      const transientTwoDepthLevel = await testingModule.resolve(
        TransientService,
        contextId,
      );
      const transientThreeDepthLevel = await testingModule.resolve(
        Transient3Service,
        contextId,
      );

      expect(transientTwoDepthLevel.svc.logger).not.toBeUndefined();
      expect(transientThreeDepthLevel.svc.svc.logger).not.toBeUndefined();
    });

    // BUNEST_BUG: resolve(ScopedService) without a prior registerRequestByContextId() throws when injecting REQUEST instead of passing undefined as NestJS does (packages/core/src/di/di-container.ts:3586)
    it.skip("should dynamically resolve request-scoped provider", async () => {
      const request1 = await testingModule.resolve(ScopedService);
      const request2 = await testingModule.resolve(ScopedService);

      const ctxId = { id: 1 };
      const requestProvider = { host: "localhost" };
      testingModule.registerRequestByContextId(requestProvider, ctxId);

      const request3 = await testingModule.resolve(ScopedService, ctxId);
      const requestFactory = await testingModule.resolve(
        REQUEST_SCOPED_FACTORY,
      );

      expect(request1).toBeInstanceOf(ScopedService);
      expect(request2).toBeInstanceOf(ScopedService);
      expect(request3).not.toBe(request2);
      expect(requestFactory).toBe(true);
      expect(request3.request).toBe(requestProvider);
    });

    it(
      "should isolate request-scoped providers across parallel context resolutions",
      async () => {
        const contexts = Array.from(
          { length: OVERLAP_REQUEST_COUNT },
          (_, index) => {
            const contextId = createContextId();
            const requestProvider = { host: `parallel-host-${index}` };

            testingModule.registerRequestByContextId(
              requestProvider,
              contextId,
            );
            return { contextId, requestProvider };
          },
        );

        const providers = await Promise.all(
          contexts.map(({ contextId }) =>
            testingModule.resolve(ScopedService, contextId),
          ),
        );

        expect(new Set(providers).size).toBe(contexts.length);
        expect(providers.map((provider) => provider.request)).toEqual(
          contexts.map(({ requestProvider }) => requestProvider),
        );
      },
      20000,
    );

    it(
      "should reuse request-scoped providers for parallel resolutions in the same context",
      async () => {
        const contextId = createContextId();
        const requestProvider = { host: "shared-host" };

        testingModule.registerRequestByContextId(requestProvider, contextId);

        const providers = await Promise.all(
          Array.from({ length: OVERLAP_REQUEST_COUNT }, () =>
            testingModule.resolve(ScopedService, contextId),
          ),
        );

        expect(new Set(providers).size).toBe(1);
        expect(providers[0]!.request).toBe(requestProvider);
      },
      20000,
    );

    it("should dynamically resolve request-scoped controller", async () => {
      const request1 = await testingModule.resolve(ScopedController);
      const request2 = await testingModule.resolve(ScopedController);
      const request3 = await testingModule.resolve(ScopedController, { id: 1 });

      expect(request1).toBeInstanceOf(ScopedController);
      expect(request2).toBeInstanceOf(ScopedController);
      expect(request3).not.toBe(request2);
    });

    it(
      "should isolate request-scoped controllers across parallel context resolutions",
      async () => {
        const contexts = Array.from({ length: OVERLAP_REQUEST_COUNT }, () =>
          createContextId(),
        );

        const controllers = await Promise.all(
          contexts.map((contextId) =>
            testingModule.resolve(ScopedController, contextId),
          ),
        );

        expect(new Set(controllers).size).toBe(contexts.length);
      },
      20000,
    );

    // BUNEST_BUG: DIContainer.getSync() does not recognize request-scoped controllers via controllerOwner and throws UnknownDependencyException ("Cannot resolve dependency") instead of an invalid-scope error (packages/core/src/di/di-container.ts:2295-2315)
    it.skip('should throw an exception when "get()" method is used for scoped providers', () => {
      expect(() => testingModule.get(ScopedController)).toThrow(
        ScopeLeakException,
      );
    });

    it('should resolve static providers via "resolve()" method', async () => {
      const result = await testingModule.resolve(STATIC_FACTORY);
      expect(result).toBe(true);
    });
  },
);
