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

@Injectable({ scope: Scope.REQUEST })
class RequestGuard implements CanActivate {
  static COUNTER = 0;
  constructor() {
    RequestGuard.COUNTER++;
  }
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestInterceptor implements NestInterceptor {
  static COUNTER = 0;
  constructor() {
    RequestInterceptor.COUNTER++;
  }
  intercept(_context: ExecutionContext, call: CallHandler) {
    return call.handle();
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

@Injectable({ scope: Scope.REQUEST })
class UserByIdPipe implements PipeTransform<string> {
  static COUNTER = 0;
  constructor(private readonly usersService: UsersService) {
    UserByIdPipe.COUNTER++;
  }
  transform(value: string, _metadata: ArgumentMetadata) {
    return this.usersService.findById(value);
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
class CyclicMeta {
  static COUNTER = 0;
  constructor(
    @Inject(forwardRef(() => HelloService))
    public readonly helloService: unknown,
  ) {
    CyclicMeta.COUNTER++;
  }
}

@Injectable({ scope: Scope.REQUEST })
class AcyclicMeta {
  static COUNTER = 0;
  constructor() {
    AcyclicMeta.COUNTER++;
  }
}

@Controller({ path: "hello", scope: Scope.REQUEST })
class ExplicitRequestHelloController {
  static COUNTER = 0;
  constructor(
    private readonly helloService: HelloService,
    private readonly usersService: UsersService,
  ) {
    ExplicitRequestHelloController.COUNTER++;
  }

  @UseGuards(RequestGuard)
  @UseInterceptors(RequestInterceptor)
  @Get()
  greeting(@Param("id", UserByIdPipe) _id: string): string {
    return this.helloService.greeting();
  }
}

@Module({
  controllers: [ExplicitRequestHelloController],
  providers: [HelloService, UsersService, UserByIdPipe],
})
class ExplicitHelloModule {
  static forRoot(meta: Provider): DynamicModule {
    return {
      module: ExplicitHelloModule,
      providers: [meta],
    };
  }
}

describeConformance(
  "Circular request scope",
  {
    upstreamPath: "integration/scopes/e2e/circular-request-scope.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-007", "ADR-008", "ADR-012"],
    notes:
      "Tests ADR-012 fail-fast ScopeLeakException, ADR-007 §6 fail-fast CircularDependencyException for REQUEST-scoped forwardRef cycles, and explicit Scope.REQUEST acyclic resolution across HTTP requests.",
  },
  () => {
    describe("ADR-012 fail-fast scope-leak detection", () => {
      itAdapted(
        "ADR-012",
        "should throw ScopeLeakException when singleton controller/module injects Scope.REQUEST providers without explicit Scope.REQUEST",
        async () => {
          @Controller("leaky-hello")
          class LeakyHelloController {
            constructor(
              private readonly helloService: HelloService,
              private readonly usersService: UsersService,
            ) {}

            @Get()
            greeting() {
              return this.helloService.greeting();
            }
          }

          @Module({
            controllers: [LeakyHelloController],
            providers: [
              HelloService,
              UsersService,
              {
                provide: "META",
                useClass: AcyclicMeta,
                scope: Scope.REQUEST,
              },
            ],
          })
          class LeakyModule {}

          await expectScopeLeak(() =>
            Test.createTestingModule({
              imports: [LeakyModule],
            }).compile(),
          );
        },
      );
    });

    describe("ADR-007 §6 non-singleton forwardRef cycle rejection", () => {
      itAdapted(
        "ADR-007",
        "should fail fast with CircularDependencyException when REQUEST-scoped providers form a forwardRef cycle (HelloService <-> META)",
        async () => {
          await expect(
            Test.createTestingModule({
              imports: [
                ExplicitHelloModule.forRoot({
                  provide: "META",
                  useClass: CyclicMeta,
                  scope: Scope.REQUEST,
                }),
              ],
            }).compile(),
          ).rejects.toBeInstanceOf(CircularDependencyException);
        },
      );
    });

    describe("when one service is request scoped (explicit Scope.REQUEST, acyclic composition)", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        ExplicitRequestHelloController.COUNTER = 0;
        UsersService.COUNTER = 0;
        HelloService.COUNTER = 0;
        AcyclicMeta.COUNTER = 0;

        const module = await Test.createTestingModule({
          imports: [
            ExplicitHelloModule.forRoot({
              provide: "META",
              useClass: AcyclicMeta,
              scope: Scope.REQUEST,
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
        expect(ExplicitRequestHelloController.COUNTER).toEqual(3);
      });

      it("should create service (UsersService) for each request", () => {
        expect(UsersService.COUNTER).toEqual(3);
      });

      it("should create service (HelloService) for each request", () => {
        expect(HelloService.COUNTER).toEqual(3);
      });

      it("should create provider (Meta) for each request", () => {
        expect(AcyclicMeta.COUNTER).toEqual(3);
      });

      afterAll(async () => {
        await app?.close();
      });
    });
  },
);
