import { afterEach, beforeEach, expect } from "bun:test";
import {
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Scope,
  type ArgumentsHost,
  type ExceptionFilter,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import {
  REQUEST,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../_helpers";

describeConformance(
  "Request-scoped factory provider",
  {
    upstreamPath:
      "integration/injector/e2e/request-scoped-factory-provider.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010", "ADR-012"],
    notes:
      "Adapts FastifyAdapter/FastifyRequest to native BunestApplication/Web Request + app.inject() and explicitly declares Scope.REQUEST on TestController per ADR-012.",
  },
  () => {
    const REQUEST_SCOPED_FACTORY = "REQUEST_SCOPED_FACTORY";
    const REQUEST_COUNT = 1000;

    @Catch()
    class RecordingFilter implements ExceptionFilter {
      catch(exception: unknown, host: ArgumentsHost) {
        const response = host.switchToHttp().getResponse<ResponseContext>();
        response.status(500);
        return {
          statusCode: 500,
          message:
            exception instanceof Error
              ? exception.message
              : "Internal server error",
        };
      }
    }

    class AuthenticatedTenant {
      constructor(
        public readonly tenantName: string,
        public readonly clientName: string,
      ) {}
    }

    @Injectable()
    class JwtStrategyService {
      validate(request: Request) {
        const tenantId = request.headers.get("x-tenant-id") ?? "tenant-1";
        const clientId = request.headers.get("x-client-id") ?? "client-1";
        return {
          claim: {
            tenantId,
            clientId,
          },
          isValid: true,
        };
      }
    }

    @Injectable()
    class ConfigService {
      get(_key: string) {
        return "config-value";
      }
    }

    @Injectable()
    class InflightGate {
      private arrivalCount = 0;
      private released = false;
      private waitingResolver?: () => void;

      async waitForOverlap() {
        if (this.released) {
          return;
        }
        this.arrivalCount++;
        if (this.arrivalCount === 1) {
          await new Promise<void>((resolve) => {
            this.waitingResolver = resolve;
          });
          return;
        }
        this.released = true;
        this.waitingResolver?.();
        this.waitingResolver = undefined;
      }
    }

    const AuthenticatedTenantProvider = {
      provide: AuthenticatedTenant,
      inject: [JwtStrategyService, REQUEST, ConfigService],
      scope: Scope.REQUEST,
      useFactory: async (
        strategy: JwtStrategyService,
        request: Request,
        _config: ConfigService,
      ) => {
        const verification = strategy.validate(request);

        return new AuthenticatedTenant(
          verification.claim.tenantId,
          verification.claim.clientId,
        );
      },
    };

    @Injectable({ scope: Scope.REQUEST })
    class ActorService {
      constructor(@Inject(REQUEST) private readonly request: Request) {}

      public getActor() {
        return this.request.headers.get("x-actor-id") ?? "system";
      }
    }

    @Module({
      providers: [
        JwtStrategyService,
        ConfigService,
        AuthenticatedTenantProvider,
      ],
      exports: [AuthenticatedTenant],
    })
    class AuthModule {}

    @Module({
      providers: [ActorService],
      exports: [ActorService],
    })
    class ActorModule {}

    @Controller({ scope: Scope.REQUEST })
    class TestController {
      constructor(
        @Inject(REQUEST_SCOPED_FACTORY)
        private readonly requestScopedFactory: {
          actorId: string;
          tenantId: string;
        },
      ) {}

      @Get("/posts")
      public getValue() {
        return this.requestScopedFactory;
      }
    }

    @Module({
      imports: [AuthModule, ActorModule],
      controllers: [TestController],
      providers: [
        InflightGate,
        {
          provide: REQUEST_SCOPED_FACTORY,
          scope: Scope.REQUEST,
          inject: [AuthenticatedTenant, ActorService, InflightGate],
          useFactory: async (
            authenticatedTenant: AuthenticatedTenant,
            actorService: ActorService,
            inflightGate: InflightGate,
          ) => {
            await inflightGate.waitForOverlap();

            return {
              actorId: actorService.getActor() ?? "",
              tenantId: authenticatedTenant.tenantName,
            };
          },
        },
      ],
    })
    class TestModule {}

    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TestModule],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      app.useGlobalFilters(new RecordingFilter());
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    itAdapted(
      "ADR-012",
      "should reject singleton controller injecting request-scoped factory at bootstrap",
      async () => {
        @Controller()
        class LeakingController {
          constructor(
            @Inject(REQUEST_SCOPED_FACTORY)
            public readonly factory: unknown,
          ) {}
        }

        await expectScopeLeak(() =>
          Test.createTestingModule({
            imports: [AuthModule, ActorModule],
            controllers: [LeakingController],
            providers: [
              InflightGate,
              {
                provide: REQUEST_SCOPED_FACTORY,
                scope: Scope.REQUEST,
                inject: [AuthenticatedTenant, ActorService],
                useFactory: () => ({}),
              },
            ],
          }).compile(),
        );
      },
    );

    itAdapted(
      "ADR-001",
      "should resolve all injected dependencies across overlapping requests",
      async () => {
        const responses = await Promise.all(
          Array.from({ length: REQUEST_COUNT }, (_, index) =>
            app.inject({
              method: "GET",
              url: "/posts",
              headers: {
                "x-actor-id": `actor-${index}`,
                "x-client-id": `client-${index}`,
                "x-tenant-id": `tenant-${index}`,
              },
            }),
          ),
        );

        const failures = responses.flatMap((response, index) => {
          if (response.statusCode !== 200) {
            return [
              {
                body: response.body,
                index,
                statusCode: response.statusCode,
              },
            ];
          }
          return [];
        });

        expect(failures).toEqual([]);

        const payloads = responses.map((response) => JSON.parse(response.body));
        expect(payloads).toEqual(
          Array.from({ length: REQUEST_COUNT }, (_, index) => ({
            actorId: `actor-${index}`,
            tenantId: `tenant-${index}`,
          })),
        );
      },
      20000,
    );
  },
);
