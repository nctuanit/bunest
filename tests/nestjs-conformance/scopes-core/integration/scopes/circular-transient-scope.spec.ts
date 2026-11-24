import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
  forwardRef,
  type ArgumentMetadata,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
  type Provider,
} from "../../../../../packages/core/src/common";
import {
  CircularDependencyException,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers";

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
  transform(value: string, _metadata: ArgumentMetadata) {
    return value;
  }
}

@Injectable({ scope: Scope.REQUEST })
class HelloService {
  static COUNTER = 0;
  constructor(@Inject("META") public readonly meta: unknown) {
    HelloService.COUNTER++;
  }
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

@Injectable({ scope: Scope.TRANSIENT })
class CyclicMeta {
  static COUNTER = 0;
  constructor(
    @Inject(forwardRef(() => HelloService))
    public readonly helloService: unknown,
  ) {
    CyclicMeta.COUNTER++;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class AcyclicTransientMeta {
  static COUNTER = 0;
  constructor() {
    AcyclicTransientMeta.COUNTER++;
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
  static forRoot(meta: Provider): DynamicModule {
    return {
      module: HelloModule,
      providers: [meta],
    };
  }
}

describeConformance(
  "Circular transient scope",
  {
    upstreamPath: "integration/scopes/e2e/circular-transient-scope.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-007", "ADR-008", "ADR-012"],
    notes:
      "Tests ADR-012 ScopeLeakException when singleton module constructor injects transient provider depending on Scope.REQUEST, ADR-007 §6 fail-fast CircularDependencyException for non-singleton forwardRef cycles, and explicit Scope.REQUEST + Scope.TRANSIENT acyclic resolution.",
  },
  () => {
    describe("ADR-012 fail-fast scope-leak detection", () => {
      itAdapted(
        "ADR-012",
        "should throw ScopeLeakException when singleton module constructor or controller injects transient provider that depends on Scope.REQUEST",
        async () => {
          @Injectable({ scope: Scope.REQUEST })
          class RequestDep {}

          @Injectable({ scope: Scope.TRANSIENT })
          class LeakyTransientMeta {
            constructor(public readonly reqDep: RequestDep) {}
          }

          @Module({
            providers: [
              RequestDep,
              {
                provide: "META",
                useClass: LeakyTransientMeta,
                scope: Scope.TRANSIENT,
              },
            ],
          })
          class LeakyHelloModule {
            constructor(@Inject("META") _meta: unknown) {}
          }

          await expectScopeLeak(() =>
            Test.createTestingModule({
              imports: [LeakyHelloModule],
            }).compile(),
          );
        },
      );
    });

    describe("ADR-007 §6 non-singleton forwardRef cycle rejection", () => {
      itAdapted(
        "ADR-007",
        "should fail fast with CircularDependencyException when REQUEST/TRANSIENT providers form a forwardRef cycle (HelloService <-> META)",
        async () => {
          await expect(
            Test.createTestingModule({
              imports: [
                HelloModule.forRoot({
                  provide: "META",
                  useClass: CyclicMeta,
                  scope: Scope.TRANSIENT,
                }),
              ],
            }).compile(),
          ).rejects.toBeInstanceOf(CircularDependencyException);
        },
      );
    });

    describe("when one service is request scoped (explicit Scope.REQUEST controller, acyclic transient)", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        HelloController.COUNTER = 0;
        UsersService.COUNTER = 0;
        HelloService.COUNTER = 0;
        AcyclicTransientMeta.COUNTER = 0;

        const module = await Test.createTestingModule({
          imports: [
            HelloModule.forRoot({
              provide: "META",
              useClass: AcyclicTransientMeta,
              scope: Scope.TRANSIENT,
            }),
          ],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();

        await request(app).get("/hello").expect(200, "Hello world!");
        await request(app).get("/hello").expect(200, "Hello world!");
        await request(app).get("/hello").expect(200, "Hello world!");
      });

      it("should create controller for each request", () => {
        expect(HelloController.COUNTER).toEqual(3);
      });

      it("should create service (UsersService) for each request", () => {
        expect(UsersService.COUNTER).toEqual(3);
      });

      it("should create service (HelloService) for each request", () => {
        expect(HelloService.COUNTER).toEqual(3);
      });

      it("should create transient provider for each inquirer per request (2 per request x 3 requests = 6)", () => {
        // Without singleton module constructor injection (which fails ADR-012),
        // Meta is injected into HelloService and UsersService on each of the 3 requests.
        expect(AcyclicTransientMeta.COUNTER).toEqual(6);
      });

      afterAll(async () => {
        await app?.close();
      });
    });
  },
);
