import { describe, expect, it } from "bun:test";
import {
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  Inject,
  Injectable,
  Module,
  type NestInterceptor,
  type Provider,
  Scope,
  UseGuards,
  UseInterceptors,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CONTEXT,
  GraphQLModule,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers/index";

const CATS_TYPE_DEFS = `
  type Query {
    getCats: [Cat]
  }

  type Cat {
    id: Int
    name: String
    age: Int
    color: String
    weight: Int
  }
`;

class Meta {
  static COUNTER = 0;
  constructor() {
    Meta.COUNTER++;
  }
}

@Injectable({ scope: Scope.REQUEST })
class HelloService {
  constructor(@Inject("META") readonly meta: unknown) {}

  getCats() {
    return [{ id: 1, name: "Cat", age: 5, color: "black", weight: 5 }];
  }
}

@Injectable({ scope: Scope.REQUEST })
class UsersService {
  static COUNTER = 0;
  static REQUEST_CONTEXTS: Array<{ req?: unknown }> = [];

  constructor(
    @Inject("META") readonly meta: unknown,
    @Inject(CONTEXT) private readonly context: { req?: unknown },
  ) {
    UsersService.COUNTER++;
    UsersService.REQUEST_CONTEXTS.push(this.context);
  }

  findById(id: string) {
    return { id };
  }
}

@Injectable({ scope: Scope.REQUEST })
class Guard implements CanActivate {
  static COUNTER = 0;
  static REQUEST_SCOPED_DATA: number[] = [];

  constructor(@Inject("REQUEST_ID") private readonly requestId: number) {
    Guard.COUNTER++;
  }

  canActivate(_context: ExecutionContext): boolean {
    Guard.REQUEST_SCOPED_DATA.push(this.requestId);
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
class Interceptor implements NestInterceptor {
  static COUNTER = 0;
  static REQUEST_SCOPED_DATA: number[] = [];

  constructor(@Inject("REQUEST_ID") private readonly requestId: number) {
    Interceptor.COUNTER++;
  }

  async intercept(
    _context: ExecutionContext,
    call: CallHandler,
  ): Promise<unknown> {
    Interceptor.REQUEST_SCOPED_DATA.push(this.requestId);
    return await call.handle();
  }
}

@Resolver()
class SingletonHelloResolver {
  constructor(private readonly helloService: HelloService) {}

  @Query(() => [Object], { name: "getCats" })
  getCats() {
    return this.helloService.getCats();
  }
}

@Injectable({ scope: Scope.REQUEST })
@Resolver()
class HelloResolver {
  static COUNTER = 0;

  constructor(
    private readonly helloService: HelloService,
    private readonly _usersService: UsersService,
  ) {
    HelloResolver.COUNTER++;
  }

  @Query(() => [Object], { name: "getCats" })
  @UseGuards(Guard)
  @UseInterceptors(Interceptor)
  getCats() {
    void this._usersService;
    return this.helloService.getCats();
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      typeDefs: CATS_TYPE_DEFS,
    }),
  ],
  providers: [
    HelloResolver,
    HelloService,
    UsersService,
    Guard,
    Interceptor,
    {
      provide: "REQUEST_ID",
      useFactory: () => 1,
      scope: Scope.REQUEST,
    },
  ],
})
class HelloModule {
  constructor(@Inject("META") readonly meta: unknown) {}

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
    upstreamPath: "packages/apollo/tests/e2e/request-scoped.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-012"],
    notes:
      "Adapts interceptor to zero-RxJS Promise pipeline (ADR-008), tests ADR-012 fail-fast ScopeLeakException for singleton resolvers injecting Scope.REQUEST services, and exercises explicit Scope.REQUEST resolver/guard/interceptor/service behavior.",
  },
  () => {
    itAdapted(
      "ADR-012",
      "should throw ScopeLeakException when a singleton resolver injects a Scope.REQUEST service",
      async () => {
        @Module({
          imports: [GraphQLModule.forRoot({ typeDefs: CATS_TYPE_DEFS })],
          providers: [
            { provide: "META", useClass: Meta },
            HelloService,
            SingletonHelloResolver,
          ],
        })
        class LeakyHelloModule {}

        await expectScopeLeak(async () => {
          const mod = await Test.createTestingModule({
            imports: [LeakyHelloModule],
          }).compile({ logger: false });
          await mod.close();
        });
      },
    );

    describe("when one service is request scoped", () => {
      async function runThreeRequests(): Promise<void> {
        Meta.COUNTER = 0;
        HelloResolver.COUNTER = 0;
        UsersService.COUNTER = 0;
        UsersService.REQUEST_CONTEXTS = [];
        Guard.COUNTER = 0;
        Guard.REQUEST_SCOPED_DATA = [];
        Interceptor.COUNTER = 0;
        Interceptor.REQUEST_SCOPED_DATA = [];

        const moduleRef = await Test.createTestingModule({
          imports: [
            HelloModule.forRoot({
              provide: "META",
              useClass: Meta,
            }),
          ],
        }).compile({ logger: false });

        const app: BunestApplication = moduleRef.createNestApplication({
          logger: false,
        });
        await app.init();

        try {
          const performHttpCall = () =>
            request(app)
              .post("/graphql")
              .send({
                operationName: null,
                variables: {},
                query: `
                {
                  getCats {
                    id,
                    color,
                    weight
                  }
                }`,
              });

          await performHttpCall();
          await performHttpCall();
          await performHttpCall();
        } finally {
          await app.close();
        }
      }

      it("should create resolver for each request", async () => {
        await runThreeRequests();
        expect(HelloResolver.COUNTER).toEqual(3);
      });

      it("should create service for each request", async () => {
        await runThreeRequests();
        expect(UsersService.COUNTER).toEqual(3);
      });

      it("should share static provider across requests", async () => {
        await runThreeRequests();
        expect(Meta.COUNTER).toEqual(1);
      });

      it("should create request scoped interceptor for each request", async () => {
        await runThreeRequests();
        expect(Interceptor.COUNTER).toEqual(3);
        expect(Interceptor.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
      });

      it("should create request scoped guard for each request", async () => {
        await runThreeRequests();
        expect(Guard.COUNTER).toEqual(3);
        expect(Guard.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
      });

      it("should inject REQUEST context into request-scoped services", async () => {
        await runThreeRequests();
        expect(UsersService.REQUEST_CONTEXTS).toHaveLength(3);
        UsersService.REQUEST_CONTEXTS.forEach((context) => {
          expect(context).toBeDefined();
          expect(context.req).toBeDefined();
        });
      });
    });
  },
);
