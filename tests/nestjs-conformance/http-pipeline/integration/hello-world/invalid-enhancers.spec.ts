import { afterEach, expect, it } from "bun:test";
import {
  Catch,
  Controller,
  Get,
  Injectable,
  Logger,
  UseGuards,
  mixin,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
  type Type,
} from "../../../../../packages/core/src/common";
import {
  APP_FILTER,
  APP_GUARD,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { Test, describeConformance, itAdapted, stubMethod } from "../../../_helpers";

// An abstract class used as a DI token, with the implementation provided
// under it: what `@UseGuards()` gets is the abstract class itself.
abstract class AuthGuard implements CanActivate {
  abstract canActivate(): boolean;
}

@Injectable()
class TokenAuthGuard extends AuthGuard {
  canActivate() {
    return false;
  }
}

function RoleGuard(role: string): Type<CanActivate> {
  class RoleGuardMixin implements CanActivate {
    canActivate() {
      return role === "none";
    }
  }
  return mixin(RoleGuardMixin);
}

@Controller()
class SecretController {
  @UseGuards(AuthGuard as unknown as Type<CanActivate>)
  @Get("secret")
  secret() {
    return "secret";
  }
}

@Controller()
class OpenController {
  @Get("open")
  open() {
    return "open";
  }
}

@Catch()
class EverythingFilter implements ExceptionFilter {
  catch(_exception: unknown, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(418);
    return new Response(null, { status: 418 });
  }
}

describeConformance(
  "Enhancers that are not enhancers",
  {
    upstreamPath: "integration/hello-world/e2e/invalid-enhancers.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it('should fail to start when a guard bound with @UseGuards() has no "canActivate"', async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [SecretController],
        providers: [{ provide: AuthGuard, useClass: TokenAuthGuard }],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });

      await expect(app.init()).rejects.toThrow(/InvalidEnhancer|canActivate/i);
    });

    it("should fail to start when APP_GUARD gives a guard class instead of an instance", async () => {
      await expect(
        (async () => {
          const moduleRef = await Test.createTestingModule({
            controllers: [OpenController],
            providers: [{ provide: APP_GUARD, useValue: RoleGuard("admin") }],
          }).compile();
          app = moduleRef.createNestApplication({ logger: false });
          await app.init();
        })(),
      ).rejects.toThrow(/APP_GUARD provider \(useValue\) gives class/);
    });

    it("should only warn when APP_FILTER gives a filter class instead of an instance", async () => {
      const warn = stubMethod(Logger.prototype, "warn");
      try {
        const moduleRef = await Test.createTestingModule({
          controllers: [OpenController],
          providers: [{ provide: APP_FILTER, useValue: EverythingFilter }],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();

        expect(
          warn.args.some(
            (call) =>
              typeof call[0] === "string" &&
              call[0].includes(
                "The exception filter (APP_FILTER provider (useValue) gives class EverythingFilter)",
              ),
          ),
        ).toBe(true);
      } finally {
        warn.restore();
      }
    });

    itAdapted(
      "ADR-008",
      "should accept a guard class constructor in useGlobalGuards() via DI resolution",
      async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [OpenController],
          providers: [TokenAuthGuard],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });

        expect(() => app!.useGlobalGuards(TokenAuthGuard as any)).not.toThrow();
        await app.init();
      },
      "Bunest supports GuardLike class constructors in app.useGlobalGuards() resolved via DI",
    );
  },
);
