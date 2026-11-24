import { afterEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  REQUEST,
  Scope,
  UseGuards,
  type CanActivate,
} from "../../../../../packages/core/src/common";
import {
  ModuleRef,
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
class Session {
  constructor(@Inject(REQUEST) private readonly req: Request) {}

  isMember() {
    return this.req.headers.get("x-member") === "true";
  }
}

@Injectable()
class ImplicitMembersGuard implements CanActivate {
  constructor(private readonly session: Session) {}

  canActivate = () => this.session.isMember();
}

@Injectable({ scope: Scope.REQUEST })
class ExplicitRequestMembersGuard implements CanActivate {
  constructor(private readonly session: Session) {}

  canActivate = () => this.session.isMember();
}

@Injectable({ scope: Scope.REQUEST })
class RequestVaultHandlers {
  @UseGuards(ExplicitRequestMembersGuard)
  open() {
    return "vault";
  }
}

@Controller({ path: "vault", scope: Scope.REQUEST })
class ExplicitVaultController {
  @UseGuards(ExplicitRequestMembersGuard)
  @Get()
  open() {
    return "vault";
  }
}

describeConformance(
  "Enhancers request-scoped through their dependencies",
  {
    upstreamPath:
      "integration/scopes/e2e/request-scoped-enhancer-dependencies.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Tests BOTH ADR-012 fail-fast ScopeLeakException when a singleton guard depends on Scope.REQUEST Session AND explicit Scope.REQUEST guard/controller execution.",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    itAdapted(
      "ADR-012",
      "should fail fast with ScopeLeakException when singleton guard injects Scope.REQUEST Session without explicit Scope.REQUEST",
      async () => {
        @Controller("leaky-vault")
        class LeakyVaultController {
          @UseGuards(ImplicitMembersGuard)
          @Get()
          open() {
            return "vault";
          }
        }

        await expectScopeLeak(() =>
          Test.createTestingModule({
            controllers: [LeakyVaultController],
            providers: [Session],
          }).compile(),
        );
      },
    );

    describe("with explicit Scope.REQUEST on guard and host", () => {
      it("should report Scope.REQUEST on introspected request-scoped provider", async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [ExplicitVaultController],
          providers: [Session, RequestVaultHandlers],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();

        expect(app.get(ModuleRef).introspect(RequestVaultHandlers).scope).toBe(
          Scope.REQUEST,
        );
      });

      it("should run request-scoped guard on controller that shares it with a provider", async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [ExplicitVaultController],
          providers: [Session, RequestVaultHandlers],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();

        await request(app).get("/vault").expect(403);
        await request(app)
          .get("/vault")
          .set("x-member", "true")
          .expect(200, "vault");
      });
    });
  },
);
