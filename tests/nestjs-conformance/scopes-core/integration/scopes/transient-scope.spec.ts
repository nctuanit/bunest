import "reflect-metadata";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Scope,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
  type Provider,
} from "../../../../../packages/common/src";
import {
  createContextId,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers";

class Meta {
  static COUNTER = 0;
  constructor() {
    Meta.COUNTER++;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientGuard implements CanActivate {
  static COUNTER = 0;
  constructor() {
    TransientGuard.COUNTER++;
  }
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientInterceptor implements NestInterceptor {
  static COUNTER = 0;
  constructor() {
    TransientInterceptor.COUNTER++;
  }
  intercept(_context: ExecutionContext, call: CallHandler) {
    return call.handle();
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class UserByIdPipe implements PipeTransform<string> {
  static COUNTER = 0;
  constructor() {
    UserByIdPipe.COUNTER++;
  }
  transform(value: string) {
    return value;
  }
}

@Injectable({ scope: Scope.REQUEST })
class HelloService {
  constructor(@Inject("META") public readonly meta: unknown) {}
  greeting(): string {
    return "Hello world!";
  }
}

@Injectable({ scope: Scope.REQUEST })
class UsersService {
  static COUNTER = 0;
  constructor(@Inject("META") public readonly meta: unknown) {
    UsersService.COUNTER++;
  }
  findById(id: string) {
    return { id };
  }
}

@Controller({ path: "hello", scope: Scope.REQUEST })
class HelloController {
  static COUNTER = 0;
  constructor(
    private readonly helloService: HelloService,
    private readonly usersService: UsersService,
  ) {
    HelloController.COUNTER++;
  }

  @UseGuards(TransientGuard)
  @UseInterceptors(TransientInterceptor)
  @Get()
  greeting(@Param("id", UserByIdPipe) _id: string): string {
    return this.helloService.greeting();
  }
}

@Controller("test")
class TestController {
  @UseGuards(TransientGuard)
  @UseInterceptors(TransientInterceptor)
  @Get()
  greeting(@Param("id", UserByIdPipe) _id: string): string {
    return "hey";
  }
}

@Module({
  controllers: [HelloController, TestController],
  providers: [HelloService, UsersService],
})
class HelloModule {
  constructor(@Inject("META") public readonly meta: unknown) {}

  static forRoot(meta: Provider): DynamicModule {
    return {
      module: HelloModule,
      providers: [meta],
    };
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class NestedTransientService {
  static COUNTER = 0;
  public readonly instanceId: number;
  private context?: string;

  constructor() {
    NestedTransientService.COUNTER++;
    this.instanceId = NestedTransientService.COUNTER;
  }

  setContext(ctx: string) {
    this.context = ctx;
  }

  getContext(): string | undefined {
    return this.context;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientLoggerService {
  static COUNTER = 0;
  public readonly instanceId: number;

  constructor(public readonly nested: NestedTransientService) {
    TransientLoggerService.COUNTER++;
    this.instanceId = TransientLoggerService.COUNTER;
  }

  setContext(ctx: string) {
    this.nested.setContext(`NESTED-${ctx}`);
  }

  getNestedContext(): string | undefined {
    return this.nested.getContext();
  }

  getNestedInstanceId(): number {
    return this.nested.instanceId;
  }
}

@Injectable({ scope: Scope.REQUEST })
class FirstRequestService {
  static COUNTER = 0;

  constructor(public readonly logger: TransientLoggerService) {
    FirstRequestService.COUNTER++;
    this.logger.setContext("FirstService");
  }
}

@Injectable({ scope: Scope.REQUEST })
class SecondRequestService {
  static COUNTER = 0;

  constructor(public readonly logger: TransientLoggerService) {
    SecondRequestService.COUNTER++;
    this.logger.setContext("SecondService");
  }
}

@Controller({ path: "nested-transient", scope: Scope.REQUEST })
class NestedTransientController {
  static COUNTER = 0;

  constructor(
    private readonly firstService: FirstRequestService,
    private readonly secondService: SecondRequestService,
  ) {
    NestedTransientController.COUNTER++;
  }

  @Get()
  getIsolationData() {
    return {
      firstServiceContext: this.firstService.logger.getNestedContext(),
      firstServiceNestedId: this.firstService.logger.getNestedInstanceId(),
      secondServiceContext: this.secondService.logger.getNestedContext(),
      secondServiceNestedId: this.secondService.logger.getNestedInstanceId(),
    };
  }
}

@Module({
  controllers: [NestedTransientController],
  providers: [
    FirstRequestService,
    SecondRequestService,
    TransientLoggerService,
    NestedTransientService,
  ],
})
class NestedTransientModule {}

describeConformance(
  "Transient scope",
  {
    upstreamPath: "integration/scopes/e2e/transient-scope.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-012"],
  },
  () => {
    describe("when transient scope is used", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        Meta.COUNTER = 0;
        HelloController.COUNTER = 0;
        UsersService.COUNTER = 0;
        UserByIdPipe.COUNTER = 0;
        TransientInterceptor.COUNTER = 0;
        TransientGuard.COUNTER = 0;

        const module = await Test.createTestingModule({
          imports: [
            HelloModule.forRoot({
              provide: "META",
              useClass: Meta,
              scope: Scope.TRANSIENT,
            }),
          ],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();
      });

      describe("and when one service is request scoped", () => {
        beforeAll(async () => {
          await request(app).get("/hello").expect(200);
          await request(app).get("/hello").expect(200);
          await request(app).get("/hello").expect(200);
        });

        it("should create controller for each request", () => {
          expect(HelloController.COUNTER).toEqual(3);
        });

        it("should create service for each request", () => {
          expect(UsersService.COUNTER).toEqual(3);
        });

        it("should create provider for each inquirer", () => {
          // 1 for HelloModule ctor + 2 per request (HelloService + UsersService) x 3 = 7
          expect(Meta.COUNTER).toEqual(7);
        });

        it("should create transient pipe for each controller/request", () => {
          expect(UserByIdPipe.COUNTER).toBeGreaterThanOrEqual(3);
        });

        it("should create transient interceptor for each controller/request", () => {
          expect(TransientInterceptor.COUNTER).toBeGreaterThanOrEqual(3);
        });

        it("should create transient guard for each controller/request", () => {
          expect(TransientGuard.COUNTER).toBeGreaterThanOrEqual(3);
        });
      });

      afterAll(async () => {
        await app.close();
      });
    });

    itAdapted(
      "ADR-012",
      "should throw ScopeLeakException if singleton HelloController omits { scope: Scope.REQUEST } while injecting request-scoped HelloService",
      async () => {
        @Controller("leaky")
        class LeakyHelloController {
          constructor(private readonly helloService: HelloService) {}
          @Get()
          greet() {
            return this.helloService.greeting();
          }
        }

        await expectScopeLeak(() =>
          Test.createTestingModule({
            controllers: [LeakyHelloController],
            providers: [
              HelloService,
              { provide: "META", useClass: Meta, scope: Scope.TRANSIENT },
            ],
          }).compile(),
        );
      },
    );

    describe("when there is a nested structure of transient providers", () => {
      let app: BunestApplication;

      @Injectable({ scope: Scope.TRANSIENT })
      class DeepTransient {
        public initialized = false;
        constructor() {
          this.initialized = true;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class LoggerService {
        public context?: string;
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class SecondService {
        constructor(public readonly loggerService: LoggerService) {
          this.loggerService.context = "SecondService";
        }
      }

      @Injectable()
      class FirstService {
        constructor(
          public readonly secondService: SecondService,
          public readonly loggerService: LoggerService,
          public readonly deepTransient: DeepTransient,
        ) {
          this.loggerService.context = "FirstService";
        }
      }

      beforeAll(async () => {
        const module = await Test.createTestingModule({
          providers: [FirstService, SecondService, LoggerService, DeepTransient],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();
      });

      it("should create a new instance of the transient provider for each provider", () => {
        const firstService1 = app.get(FirstService);

        expect(firstService1.secondService.loggerService.context).toBe(
          "SecondService",
        );
        expect(firstService1.loggerService.context).toBe("FirstService");
        expect(firstService1.deepTransient.initialized).toBe(true);
      });

      afterAll(async () => {
        await app.close();
      });
    });

    describe("when DEFAULT scoped provider has deeply nested TRANSIENT chain", () => {
      let app: BunestApplication;

      @Injectable({ scope: Scope.TRANSIENT })
      class DeepNestedTransient {
        public static constructorCalled = false;
        constructor() {
          DeepNestedTransient.constructorCalled = true;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class MiddleTransient {
        constructor(public readonly nested: DeepNestedTransient) {}
      }

      @Injectable()
      class RootService {
        constructor(public readonly middle: MiddleTransient) {}
      }

      beforeAll(async () => {
        DeepNestedTransient.constructorCalled = false;
        const module = await Test.createTestingModule({
          providers: [RootService, MiddleTransient, DeepNestedTransient],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();
      });

      it("should call constructor of deeply nested TRANSIENT provider", () => {
        const rootService = app.get(RootService);

        expect(DeepNestedTransient.constructorCalled).toBe(true);
        expect(rootService.middle.nested).toBeInstanceOf(DeepNestedTransient);
      });

      afterAll(async () => {
        await app.close();
      });
    });

    describe("when multiple DEFAULT parents inject the same TRANSIENT -> TRANSIENT chain", () => {
      let app: BunestApplication;

      @Injectable({ scope: Scope.TRANSIENT })
      class IsolatedNestedTransient {
        public static instanceCount = 0;
        public readonly instanceId: number;
        constructor() {
          IsolatedNestedTransient.instanceCount++;
          this.instanceId = IsolatedNestedTransient.instanceCount;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class IsolatedTransientLogger {
        public static instanceCount = 0;
        public readonly instanceId: number;
        constructor(public readonly nested: IsolatedNestedTransient) {
          IsolatedTransientLogger.instanceCount++;
          this.instanceId = IsolatedTransientLogger.instanceCount;
        }
      }

      @Injectable()
      class ServiceA {
        constructor(public readonly logger: IsolatedTransientLogger) {}
      }

      @Injectable()
      class ServiceB {
        constructor(public readonly logger: IsolatedTransientLogger) {}
      }

      beforeAll(async () => {
        IsolatedNestedTransient.instanceCount = 0;
        IsolatedTransientLogger.instanceCount = 0;

        const module = await Test.createTestingModule({
          providers: [
            ServiceA,
            ServiceB,
            IsolatedTransientLogger,
            IsolatedNestedTransient,
          ],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();
      });

      it("should create separate TransientLogger instances for each DEFAULT parent", () => {
        const serviceA = app.get(ServiceA);
        const serviceB = app.get(ServiceB);

        expect(serviceA.logger.instanceId).not.toBe(serviceB.logger.instanceId);
      });

      it("should create separate nested TRANSIENT instances for each DEFAULT parent", () => {
        const serviceA = app.get(ServiceA);
        const serviceB = app.get(ServiceB);

        expect(serviceA.logger.nested.instanceId).not.toBe(
          serviceB.logger.nested.instanceId,
        );
      });

      afterAll(async () => {
        await app.close();
      });
    });

    describe("when multiple DEFAULT parents inject a deeply nested TRANSIENT chain", () => {
      let app: BunestApplication;

      @Injectable({ scope: Scope.TRANSIENT })
      class DepthSixTransient {
        public static constructorCalled = false;
        public static instanceCount = 0;
        public readonly instanceId: number;
        public readonly initialized = true;
        constructor() {
          DepthSixTransient.constructorCalled = true;
          DepthSixTransient.instanceCount++;
          this.instanceId = DepthSixTransient.instanceCount;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class DepthFiveTransient {
        public static constructorCalled = false;
        public static instanceCount = 0;
        public readonly instanceId: number;
        constructor(public readonly next: DepthSixTransient) {
          DepthFiveTransient.constructorCalled = true;
          DepthFiveTransient.instanceCount++;
          this.instanceId = DepthFiveTransient.instanceCount;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class DepthFourTransient {
        public static constructorCalled = false;
        constructor(public readonly next: DepthFiveTransient) {
          DepthFourTransient.constructorCalled = true;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class DepthThreeTransient {
        public static constructorCalled = false;
        constructor(public readonly next: DepthFourTransient) {
          DepthThreeTransient.constructorCalled = true;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class DepthTwoTransient {
        public static constructorCalled = false;
        constructor(public readonly next: DepthThreeTransient) {
          DepthTwoTransient.constructorCalled = true;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class DepthOneTransient {
        public static constructorCalled = false;
        constructor(public readonly next: DepthTwoTransient) {
          DepthOneTransient.constructorCalled = true;
        }
      }

      @Injectable()
      class DeepServiceA {
        constructor(public readonly chain: DepthOneTransient) {}
      }

      @Injectable()
      class DeepServiceB {
        constructor(public readonly chain: DepthOneTransient) {}
      }

      beforeAll(async () => {
        DepthOneTransient.constructorCalled = false;
        DepthTwoTransient.constructorCalled = false;
        DepthThreeTransient.constructorCalled = false;
        DepthFourTransient.constructorCalled = false;
        DepthFiveTransient.constructorCalled = false;
        DepthSixTransient.constructorCalled = false;
        DepthFiveTransient.instanceCount = 0;
        DepthSixTransient.instanceCount = 0;

        const module = await Test.createTestingModule({
          providers: [
            DeepServiceA,
            DeepServiceB,
            DepthOneTransient,
            DepthTwoTransient,
            DepthThreeTransient,
            DepthFourTransient,
            DepthFiveTransient,
            DepthSixTransient,
          ],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();
      });

      it("should create separate level-5 transient instances for each DEFAULT parent", () => {
        const serviceA = app.get(DeepServiceA);
        const serviceB = app.get(DeepServiceB);

        expect(serviceA.chain.next.next.next.next.instanceId).not.toBe(
          serviceB.chain.next.next.next.next.instanceId,
        );
      });

      it("should create separate level-6 transient instances for each DEFAULT parent", () => {
        const serviceA = app.get(DeepServiceA);
        const serviceB = app.get(DeepServiceB);

        expect(serviceA.chain.next.next.next.next.next.instanceId).not.toBe(
          serviceB.chain.next.next.next.next.next.instanceId,
        );
        expect(serviceA.chain.next.next.next.next.next.initialized).toBe(true);
        expect(serviceB.chain.next.next.next.next.next.initialized).toBe(true);
      });

      it("should call constructors for every transient provider in the deep chain", () => {
        app.get(DeepServiceA);
        app.get(DeepServiceB);

        expect(DepthOneTransient.constructorCalled).toBe(true);
        expect(DepthTwoTransient.constructorCalled).toBe(true);
        expect(DepthThreeTransient.constructorCalled).toBe(true);
        expect(DepthFourTransient.constructorCalled).toBe(true);
        expect(DepthFiveTransient.constructorCalled).toBe(true);
        expect(DepthSixTransient.constructorCalled).toBe(true);
      });

      afterAll(async () => {
        await app.close();
      });
    });

    describe("when nested transient providers are used in request scope", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        NestedTransientService.COUNTER = 0;
        const module = await Test.createTestingModule({
          imports: [NestedTransientModule],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();
      });

      it("should isolate nested transient instances for each parent service", async () => {
        const response = await request(app).get("/nested-transient").expect(200);
        const body = response.body as any;

        expect(body.firstServiceContext).toBe("NESTED-FirstService");
        expect(body.secondServiceContext).toBe("NESTED-SecondService");
        expect(body.firstServiceNestedId).not.toBe(body.secondServiceNestedId);
      });

      afterAll(async () => {
        await app.close();
      });
    });

    describe("when request-scoped providers have a deeply nested transient chain", () => {
      let app: BunestApplication;

      @Injectable({ scope: Scope.TRANSIENT })
      class RequestDepthSixTransient {
        public static instanceCount = 0;
        public readonly instanceId: number;
        constructor() {
          RequestDepthSixTransient.instanceCount++;
          this.instanceId = RequestDepthSixTransient.instanceCount;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class RequestDepthFiveTransient {
        public static instanceCount = 0;
        public readonly instanceId: number;
        constructor(public readonly next: RequestDepthSixTransient) {
          RequestDepthFiveTransient.instanceCount++;
          this.instanceId = RequestDepthFiveTransient.instanceCount;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class RequestDepthFourTransient {
        constructor(public readonly next: RequestDepthFiveTransient) {}
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class RequestDepthThreeTransient {
        constructor(public readonly next: RequestDepthFourTransient) {}
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class RequestDepthTwoTransient {
        constructor(public readonly next: RequestDepthThreeTransient) {}
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class RequestDepthOneTransient {
        constructor(public readonly next: RequestDepthTwoTransient) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class RequestScopedParentA {
        constructor(public readonly chain: RequestDepthOneTransient) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class RequestScopedParentB {
        constructor(public readonly chain: RequestDepthOneTransient) {}
      }

      beforeEach(async () => {
        RequestDepthFiveTransient.instanceCount = 0;
        RequestDepthSixTransient.instanceCount = 0;

        const module = await Test.createTestingModule({
          providers: [
            RequestScopedParentA,
            RequestScopedParentB,
            RequestDepthOneTransient,
            RequestDepthTwoTransient,
            RequestDepthThreeTransient,
            RequestDepthFourTransient,
            RequestDepthFiveTransient,
            RequestDepthSixTransient,
          ],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      it("should create separate deep transient chains for different request-scoped parents in the same context", async () => {
        const contextId = createContextId();
        const [parentA, parentB] = await Promise.all([
          app.resolve(RequestScopedParentA, contextId),
          app.resolve(RequestScopedParentB, contextId),
        ]);

        expect(parentA).not.toBe(parentB);
        expect(parentA.chain).not.toBe(parentB.chain);
        expect(parentA.chain.next.next.next.next.instanceId).not.toBe(
          parentB.chain.next.next.next.next.instanceId,
        );
        expect(parentA.chain.next.next.next.next.next.instanceId).not.toBe(
          parentB.chain.next.next.next.next.next.instanceId,
        );
      }, 20000);

      it("should isolate deep transient chains across overlapping request contexts", async () => {
        const contextIds = Array.from({ length: 200 }, () => createContextId());
        const parents = await Promise.all(
          contextIds.map((contextId) =>
            app.resolve(RequestScopedParentA, contextId),
          ),
        );

        expect(new Set(parents).size).toBe(contextIds.length);
        expect(
          new Set(
            parents.map((parent) => parent.chain.next.next.next.next.instanceId),
          ).size,
        ).toBe(contextIds.length);
        expect(
          new Set(
            parents.map(
              (parent) => parent.chain.next.next.next.next.next.instanceId,
            ),
          ).size,
        ).toBe(contextIds.length);
      }, 20000);

      it("should reuse the same request-scoped parent while preserving a single deep transient chain per context", async () => {
        const contextId = createContextId();
        const parents = await Promise.all(
          Array.from({ length: 200 }, () =>
            app.resolve(RequestScopedParentA, contextId),
          ),
        );

        expect(new Set(parents).size).toBe(1);
        expect(
          new Set(
            parents.map((parent) => parent.chain.next.next.next.next.instanceId),
          ).size,
        ).toBe(1);
        expect(
          new Set(
            parents.map(
              (parent) => parent.chain.next.next.next.next.next.instanceId,
            ),
          ).size,
        ).toBe(1);
      }, 20000);
    });
  },
);
