import "reflect-metadata";
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
  type ArgumentMetadata,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
  type Provider,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
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
class HelloService {
  constructor(@Inject("META") public readonly meta: unknown) {}
  greeting(): string {
    return "Hello world!";
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestGuard implements CanActivate {
  static COUNTER = 0;
  static REQUEST_SCOPED_DATA: number[] = [];

  constructor(@Inject("REQUEST_ID") private readonly requestId: number) {
    RequestGuard.COUNTER++;
  }

  canActivate(_context: ExecutionContext): boolean {
    RequestGuard.REQUEST_SCOPED_DATA.push(this.requestId);
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestInterceptor implements NestInterceptor {
  static COUNTER = 0;
  static REQUEST_SCOPED_DATA: number[] = [];

  constructor(@Inject("REQUEST_ID") private readonly requestId: number) {
    RequestInterceptor.COUNTER++;
  }

  intercept(_context: ExecutionContext, call: CallHandler) {
    RequestInterceptor.REQUEST_SCOPED_DATA.push(this.requestId);
    return call.handle();
  }
}

@Injectable({ scope: Scope.REQUEST })
class UserByIdPipe implements PipeTransform<string> {
  static COUNTER = 0;
  static REQUEST_SCOPED_DATA: number[] = [];

  constructor(
    @Inject("REQUEST_ID") private readonly requestId: number,
    private readonly usersService: UsersService,
  ) {
    UserByIdPipe.COUNTER++;
  }

  transform(value: string, _metadata: ArgumentMetadata) {
    UserByIdPipe.REQUEST_SCOPED_DATA.push(this.requestId);
    return this.usersService.findById(value);
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

  @UseGuards(RequestGuard)
  @UseInterceptors(RequestInterceptor)
  @Get()
  greeting(@Param("id", UserByIdPipe) _id: string): string {
    return this.helloService.greeting();
  }
}

@Module({
  controllers: [HelloController],
  providers: [
    HelloService,
    UsersService,
    {
      provide: "REQUEST_ID",
      useFactory: () => 1,
      scope: Scope.REQUEST,
    },
  ],
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

describeConformance(
  "Request scope",
  {
    upstreamPath: "integration/scopes/e2e/request-scope.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-012"],
    notes:
      "Verifies BOTH ADR-012 fail-fast ScopeLeakException when singleton controller/pipe omits Scope.REQUEST AND full request-scoped controller/service/pipe/interceptor/guard instantiation across sequential and overlapping requests.",
  },
  () => {
    itAdapted(
      "ADR-012",
      "should throw ScopeLeakException when singleton controller or singleton pipe injects Scope.REQUEST providers",
      async () => {
        @Injectable()
        class LeakyPipe implements PipeTransform {
          constructor(private readonly users: UsersService) {}
          transform(val: string) {
            return this.users.findById(val);
          }
        }

        @Controller("leaky-hello")
        class LeakyHelloController {
          constructor(private readonly helloService: HelloService) {}
          @Get()
          greet(@Param("id", LeakyPipe) _id: string) {
            return this.helloService.greeting();
          }
        }

        await expectScopeLeak(() =>
          Test.createTestingModule({
            controllers: [LeakyHelloController],
            providers: [
              HelloService,
              UsersService,
              { provide: "META", useClass: Meta },
            ],
          }).compile(),
        );
      },
    );

    describe("with explicit Scope.REQUEST", () => {
      const OVERLAP_REQUEST_COUNT = 200;
      let app: BunestApplication;

      beforeAll(async () => {
        Meta.COUNTER = 0;
        HelloController.COUNTER = 0;
        UsersService.COUNTER = 0;
        UserByIdPipe.COUNTER = 0;
        UserByIdPipe.REQUEST_SCOPED_DATA = [];
        RequestInterceptor.COUNTER = 0;
        RequestInterceptor.REQUEST_SCOPED_DATA = [];
        RequestGuard.COUNTER = 0;
        RequestGuard.REQUEST_SCOPED_DATA = [];

        const module = await Test.createTestingModule({
          imports: [
            HelloModule.forRoot({
              provide: "META",
              useClass: Meta,
            }),
          ],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();
      });

      afterAll(async () => {
        await app.close();
      });

      describe("when one service is request scoped", () => {
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

        it("should share static provider across requests", () => {
          expect(Meta.COUNTER).toEqual(1);
        });

        it("should create request scoped pipe for each request", () => {
          expect(UserByIdPipe.COUNTER).toEqual(3);
          expect(UserByIdPipe.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
        });

        it("should create request scoped interceptor for each request", () => {
          expect(RequestInterceptor.COUNTER).toEqual(3);
          expect(RequestInterceptor.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
        });

        it("should create request scoped guard for each request", () => {
          expect(RequestGuard.COUNTER).toEqual(3);
          expect(RequestGuard.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
        });
      });

      describe("when overlapping requests are handled", () => {
        let controllerCounterBefore: number;
        let usersCounterBefore: number;
        let pipeCounterBefore: number;
        let interceptorCounterBefore: number;
        let guardCounterBefore: number;
        let pipeDataLengthBefore: number;
        let interceptorDataLengthBefore: number;
        let guardDataLengthBefore: number;
        let statuses: number[];

        beforeAll(async () => {
          controllerCounterBefore = HelloController.COUNTER;
          usersCounterBefore = UsersService.COUNTER;
          pipeCounterBefore = UserByIdPipe.COUNTER;
          interceptorCounterBefore = RequestInterceptor.COUNTER;
          guardCounterBefore = RequestGuard.COUNTER;
          pipeDataLengthBefore = UserByIdPipe.REQUEST_SCOPED_DATA.length;
          interceptorDataLengthBefore =
            RequestInterceptor.REQUEST_SCOPED_DATA.length;
          guardDataLengthBefore = RequestGuard.REQUEST_SCOPED_DATA.length;

          const responses = await Promise.all(
            Array.from({ length: OVERLAP_REQUEST_COUNT }, () =>
              request(app).get("/hello"),
            ),
          );
          statuses = responses.map((r) => r.status);
        }, 20000);

        it("should complete every overlapping request successfully", () => {
          expect(statuses).toEqual(
            Array.from({ length: OVERLAP_REQUEST_COUNT }, () => 200),
          );
        });

        it("should create a request-scoped controller and service for every overlapping request", () => {
          expect(HelloController.COUNTER - controllerCounterBefore).toBe(
            OVERLAP_REQUEST_COUNT,
          );
          expect(UsersService.COUNTER - usersCounterBefore).toBe(
            OVERLAP_REQUEST_COUNT,
          );
        });

        it("should create request-scoped enhancers for every overlapping request", () => {
          expect(UserByIdPipe.COUNTER - pipeCounterBefore).toBe(
            OVERLAP_REQUEST_COUNT,
          );
          expect(RequestInterceptor.COUNTER - interceptorCounterBefore).toBe(
            OVERLAP_REQUEST_COUNT,
          );
          expect(RequestGuard.COUNTER - guardCounterBefore).toBe(
            OVERLAP_REQUEST_COUNT,
          );
          expect(
            UserByIdPipe.REQUEST_SCOPED_DATA.slice(pipeDataLengthBefore),
          ).toEqual(Array.from({ length: OVERLAP_REQUEST_COUNT }, () => 1));
          expect(
            RequestInterceptor.REQUEST_SCOPED_DATA.slice(
              interceptorDataLengthBefore,
            ),
          ).toEqual(Array.from({ length: OVERLAP_REQUEST_COUNT }, () => 1));
          expect(
            RequestGuard.REQUEST_SCOPED_DATA.slice(guardDataLengthBefore),
          ).toEqual(Array.from({ length: OVERLAP_REQUEST_COUNT }, () => 1));
        });
      });
    });
  },
);
