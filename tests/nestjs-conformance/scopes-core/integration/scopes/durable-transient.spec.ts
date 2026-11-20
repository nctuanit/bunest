import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  REQUEST,
  Scope,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
  forwardRef,
  type CallHandler,
  type CanActivate,
  type ContextId,
  type ContextIdStrategy,
  type ExecutionContext,
  type HostComponentInfo,
  type NestInterceptor,
} from "../../../../../packages/common/src";
import {
  CircularDependencyException,
  ContextIdFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers";

const tenantSubTrees = new Map<string, ContextId>();

class TenantContextIdStrategy implements ContextIdStrategy<Request> {
  attach(contextId: ContextId, req: Request) {
    const tenantId = req.headers.get("x-tenant-id") ?? "default";
    if (!tenantSubTrees.has(tenantId)) {
      tenantSubTrees.set(tenantId, ContextIdFactory.create());
    }
    const tenantSubTree = tenantSubTrees.get(tenantId)!;
    return {
      resolve: (info: HostComponentInfo) =>
        info.isTreeDurable ? tenantSubTree : contextId,
      payload: { tenantId },
    };
  }
}

@Injectable()
class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.headers.get("authorization");
    (req as any).__user = user;
    return !!user;
  }
}

@Injectable({ scope: Scope.REQUEST, durable: true })
class TenantDatabase {
  static instances = 0;

  constructor(
    @Inject(REQUEST) private readonly tenant: { tenantId: string },
  ) {
    TenantDatabase.instances++;
  }

  findProfile(user: string) {
    return `profile of ${user} in ${this.tenant.tenantId}`;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class ProfileLoader {
  private profile?: string;

  constructor(private readonly database: TenantDatabase) {}

  load(user: string) {
    return (this.profile ??= this.database.findProfile(user));
  }
}

@Injectable({ scope: Scope.REQUEST })
class CurrentUser {
  constructor(
    @Inject(REQUEST) private readonly req: Request,
    private readonly profileLoader: ProfileLoader,
  ) {}

  getProfile() {
    return this.profileLoader.load(
      (this.req as any).__user ?? this.req.headers.get("authorization") ?? "",
    );
  }
}

@Injectable({ scope: Scope.REQUEST, durable: true })
class TenantSettings {
  static instances = 0;

  constructor(private readonly profileLoader: ProfileLoader) {
    TenantSettings.instances++;
  }

  getOwnerProfile() {
    return this.profileLoader.load("owner");
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class ProfileInterceptor implements NestInterceptor {
  private profile?: string;

  constructor(private readonly database: TenantDatabase) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();
    const user =
      (req as any).__user ?? req.headers.get("authorization") ?? "";
    this.profile ??= this.database.findProfile(user);
    const body = (await next.handle()) as Record<string, unknown>;
    return { ...body, seen: this.profile };
  }
}

@Controller({ path: "profile", scope: Scope.REQUEST })
@UseGuards(AuthGuard)
@UseInterceptors(ProfileInterceptor)
class ProfileController {
  constructor(
    private readonly currentUser: CurrentUser,
    private readonly settings: TenantSettings,
  ) {}

  @Get()
  getProfile() {
    return {
      profile: this.currentUser.getProfile(),
      owner: this.settings.getOwnerProfile(),
    };
  }
}

describeConformance(
  "Transient providers that depend on a durable provider",
  {
    upstreamPath: "integration/scopes/e2e/durable-transient.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-007", "ADR-008", "ADR-012"],
    notes:
      "Tests transient providers depending on durable providers, ADR-012 ScopeLeakException when singleton depends on transient->durable, and ADR-007 §6 rejection of transient<->durable forwardRef cycles.",
  },
  () => {
    describe("per-user isolation & durable sharing", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        tenantSubTrees.clear();
        TenantDatabase.instances = 0;
        TenantSettings.instances = 0;

        const moduleRef = await Test.createTestingModule({
          controllers: [ProfileController],
          providers: [
            TenantDatabase,
            ProfileLoader,
            CurrentUser,
            TenantSettings,
          ],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();

        ContextIdFactory.apply(new TenantContextIdStrategy());
      });

      afterAll(async () => {
        ContextIdFactory.reset();
        await app.close();
      });

      const call = (user: string) =>
        request(app)
          .get("/profile")
          .set("x-tenant-id", "acme")
          .set("authorization", user);

      it("should not serve a user with the instance created for another user of the tenant", async () => {
        await call("alice").expect(200);

        const { body } = await call("bob").expect(200);
        expect((body as any).profile).toBe("profile of bob in acme");
      });

      it("should not run a transient enhancer created for another request of the tenant", async () => {
        await call("alice").expect(200);

        const { body } = await call("bob").expect(200);
        expect((body as any).seen).toBe("profile of bob in acme");
      });

      it("should keep sharing the durable providers and the instances that they hold", async () => {
        const { body } = await call("carol").expect(200);

        expect((body as any).owner).toBe("profile of owner in acme");
        expect(TenantDatabase.instances).toBe(1);
        expect(TenantSettings.instances).toBe(1);
      });

      itAdapted(
        "ADR-012",
        "should throw ScopeLeakException if singleton TenantSettings omits Scope.REQUEST while injecting transient ProfileLoader -> durable TenantDatabase",
        async () => {
          @Injectable()
          class LeakyTenantSettings {
            constructor(public readonly loader: ProfileLoader) {}
          }

          await expectScopeLeak(() =>
            Test.createTestingModule({
              providers: [TenantDatabase, ProfileLoader, LeakyTenantSettings],
            }).compile(),
          );
        },
      );
    });

    describe("Transient and durable providers that reference each other", () => {
      itAdapted(
        "ADR-007",
        "should reject a transient <-> durable forwardRef cycle at bootstrap with CircularDependencyException",
        async () => {
          @Injectable({ scope: Scope.REQUEST, durable: true })
          class TenantGate {
            constructor(@Inject(REQUEST) _req: unknown) {
              throw new UnauthorizedException();
            }
          }

          @Injectable({ scope: Scope.TRANSIENT })
          class AuditTrail {
            constructor(
              @Inject(forwardRef(() => Ledger)) readonly ledger: unknown,
              readonly gate: TenantGate,
            ) {}
          }

          @Injectable({ scope: Scope.REQUEST, durable: true })
          class Ledger {
            constructor(
              @Inject(forwardRef(() => AuditTrail))
              readonly auditTrail: AuditTrail,
            ) {}
          }

          await expect(
            Test.createTestingModule({
              providers: [TenantGate, AuditTrail, Ledger],
            }).compile(),
          ).rejects.toBeInstanceOf(CircularDependencyException);
        },
      );

      it("should reject failed durable TenantGate attempts and succeed once tenant is allowed (acyclic durable + transient)", async () => {
        const knownTenants: string[] = [];
        const constructions = new Map<string, number>();
        const subTrees = new Map<string, ContextId>();

        class GateStrategy implements ContextIdStrategy<{ headers: Record<string, string> }> {
          attach(
            contextId: ContextId,
            req: { headers: Record<string, string> },
          ) {
            const tenantId = req.headers["x-tenant-id"] ?? "unknown";
            if (!subTrees.has(tenantId)) {
              subTrees.set(tenantId, ContextIdFactory.create());
            }
            const subTree = subTrees.get(tenantId)!;
            return (info: HostComponentInfo) =>
              info.isTreeDurable ? subTree : contextId;
          }
        }

        @Injectable({ scope: Scope.REQUEST, durable: true })
        class TenantGate {
          constructor(
            @Inject(REQUEST) req: { headers: Record<string, string> },
          ) {
            const tenantId = req.headers["x-tenant-id"] ?? "unknown";
            const count = (constructions.get(tenantId) ?? 0) + 1;
            constructions.set(tenantId, count);
            if (!knownTenants.includes(tenantId)) {
              throw new UnauthorizedException();
            }
          }
        }

        @Injectable({ scope: Scope.TRANSIENT })
        class AuditTrail {
          readonly isConstructed = true;
          constructor(readonly gate: TenantGate) {}
        }

        @Injectable({ scope: Scope.REQUEST, durable: true })
        class Ledger {
          constructor(readonly auditTrail: AuditTrail) {}
        }

        @Injectable({ scope: Scope.REQUEST })
        class LedgerConsumer {
          constructor(
            @Inject(REQUEST) readonly req: unknown,
            readonly ledger: Ledger,
          ) {}
        }

        const moduleRef = await Test.createTestingModule({
          providers: [TenantGate, AuditTrail, Ledger, LedgerConsumer],
        }).compile();
        ContextIdFactory.apply(new GateStrategy());

        try {
          const resolveFor = <T>(type: new (...args: any[]) => T, tenantId: string) => {
            const req = { headers: { "x-tenant-id": tenantId } };
            const contextId = ContextIdFactory.getByRequest(req);
            moduleRef.registerRequestByContextId(req, contextId);
            return moduleRef.resolve(type, contextId);
          };

          for (const [label, target] of [
            ["Ledger", Ledger],
            ["LedgerConsumer", LedgerConsumer],
          ] as const) {
            const tenantId = `initech-${label}`;
            for (let attempt = 1; attempt <= 3; attempt++) {
              await expect(
                resolveFor<any>(target, tenantId),
              ).rejects.toBeInstanceOf(UnauthorizedException);
              expect(constructions.get(tenantId)).toBe(attempt);
            }

            knownTenants.push(tenantId);
            const instance = await resolveFor<any>(target, tenantId);
            const ledger =
              instance instanceof LedgerConsumer ? instance.ledger : instance;
            expect(ledger.auditTrail.isConstructed).toBe(true);
            expect(ledger.auditTrail.gate).toBeInstanceOf(TenantGate);
          }
        } finally {
          ContextIdFactory.reset();
          await moduleRef.close();
        }
      });
    });
  },
);
