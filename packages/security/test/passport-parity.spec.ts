import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Module,
  Req,
  UseGuards,
  type ExecutionContext,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  AbstractStrategy,
  AuthGuard,
  AuthModuleOptions,
  CurrentUser,
  PassportModule,
  PassportSerializer,
  PassportStrategy,
  defaultPassportInstance,
  type AuthGuardAuthenticateOptions,
  type AuthOptionsFactory,
  type IAuthModuleOptions,
} from "../src";

/**
 * Zero-dependency Passport-protocol base strategy for testing `PassportStrategy` mixin.
 * Mirrors how passport-jwt / passport-http-bearer call `(options, verify)` + `authenticate(req, opts)`.
 */
class MockHeaderPassportBase {
  public name = "mock-header";
  public readonly headerName: string;
  private readonly verifyFn: (...args: any[]) => void;

  constructor(
    options: { headerName: string; passReqToCallback?: boolean },
    verify: (...args: any[]) => void,
  ) {
    this.headerName = options.headerName;
    this.verifyFn = verify;
  }

  authenticate(
    this: MockHeaderPassportBase & {
      success: (user: any, info?: any) => void;
      fail: (info?: any, status?: number) => void;
      error: (err: any) => void;
    },
    req: Request & { headers: Headers | Record<string, string> },
    options?: Record<string, any>,
  ) {
    const token =
      typeof (req.headers as Headers)?.get === "function"
        ? (req.headers as Headers).get(this.headerName)
        : (req.headers as Record<string, string>)?.[this.headerName];

    if (!token) {
      this.fail({ reason: "missing_token", scope: options?.scope }, 401);
      return;
    }

    const done = (err: any, user?: any, info?: any) => {
      if (err) return this.error(err);
      if (!user) return this.fail(info ?? { reason: "invalid_token" }, 401);
      return this.success(user, info);
    };

    this.verifyFn(token, done);
  }
}

afterEach(() => {
  defaultPassportInstance.clear();
});

describe("@nestjs/passport v12 Parity (PassportModule, PassportStrategy, IAuthGuard, PassportSerializer)", () => {
  it("supports PassportStrategy auto-registration, callbackArity, array [user, info] return, and PassportModule custom property", async () => {
    @Injectable()
    class TokenPassportStrategy extends PassportStrategy(
      MockHeaderPassportBase,
      "custom-token",
      true,
    ) {
      constructor() {
        super({ headerName: "x-passport-token" });
      }

      async validate(token: string) {
        if (token === "valid-token") {
          return [{ id: "u-77", name: "Grace" }, { via: "passport-mixin" }];
        }
        return false;
      }
    }

    @Controller("/passport")
    class PassportController {
      @UseGuards(AuthGuard())
      @Get("me")
      me(
        @CurrentUser() currentUser: { id: string; name: string },
        @Req() req: Request & { account?: { id: string; name: string }; authInfo?: unknown },
      ) {
        return {
          currentUser,
          reqAccount: req.account,
          authInfo: req.authInfo,
        };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        PassportModule.register({
          defaultStrategy: "custom-token",
          property: "account",
          session: false,
        }),
      ],
      controllers: [PassportController],
      providers: [TokenPassportStrategy],
    }).compile();

    const client = mod.createTestClient();
    try {
      // Missing token -> 401
      expect((await client.get("/passport/me")).status).toBe(401);
      // Invalid token -> 401
      expect(
        (
          await client.get("/passport/me", {
            headers: { "x-passport-token": "bad" },
          })
        ).status,
      ).toBe(401);

      // Valid token -> 200 with user attached to BOTH @CurrentUser() and req.account + req.authInfo
      const res = await client.get("/passport/me", {
        headers: { "x-passport-token": "valid-token" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        currentUser: { id: "u-77", name: "Grace" },
        reqAccount: { id: "u-77", name: "Grace" },
        authInfo: { via: "passport-mixin" },
      });
    } finally {
      await mod.close();
    }
  });

  it("supports subclassing AuthGuard() to override handleRequest, getRequest, getAuthenticateOptions, and logIn", async () => {
    @Injectable()
    class ScopedPassportStrategy extends PassportStrategy(
      MockHeaderPassportBase,
      "scoped-token",
    ) {
      constructor() {
        super({ headerName: "x-scoped" });
      }

      validate(token: string) {
        if (token === "ok") {
          return { sub: "scoped-user" };
        }
        return null;
      }
    }

    // 1. Optional auth guard overriding handleRequest
    @Injectable()
    class OptionalAuthGuard extends AuthGuard("scoped-token") {
      override handleRequest<TUser = any>(
        _err: any,
        user: any,
        info: any,
      ): TUser {
        if (!user) {
          return { anonymous: true, reason: info?.reason } as TUser;
        }
        return user as TUser;
      }

      override getAuthenticateOptions(
        _context: ExecutionContext,
      ): AuthGuardAuthenticateOptions {
        return { scope: ["profile:read"] };
      }
    }

    // 2. Strict guard overriding handleRequest to throw ForbiddenException with info
    @Injectable()
    class StrictForbiddenGuard extends AuthGuard("scoped-token") {
      override handleRequest<TUser = any>(
        err: any,
        user: any,
        info: any,
      ): TUser {
        if (err || !user) {
          throw new ForbiddenException(`Denied: ${info?.reason ?? "unknown"}`);
        }
        return user as TUser;
      }
    }

    @Controller("/guard-hooks")
    class GuardHooksController {
      @UseGuards(OptionalAuthGuard)
      @Get("optional")
      optional(@CurrentUser() user: unknown) {
        return { user };
      }

      @UseGuards(StrictForbiddenGuard)
      @Get("strict")
      strict(@CurrentUser() user: unknown) {
        return { user };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: "scoped-token" })],
      controllers: [GuardHooksController],
      providers: [ScopedPassportStrategy, OptionalAuthGuard, StrictForbiddenGuard],
    }).compile();

    const client = mod.createTestClient();
    try {
      // Optional guard allows unauthenticated request through handleRequest override
      const anonRes = await client.get("/guard-hooks/optional");
      expect(anonRes.status).toBe(200);
      expect(await anonRes.json()).toEqual({
        user: { anonymous: true, reason: "missing_token" },
      });

      // Authenticated request returns real user
      const authRes = await client.get("/guard-hooks/optional", {
        headers: { "x-scoped": "ok" },
      });
      expect(authRes.status).toBe(200);
      expect(await authRes.json()).toEqual({ user: { sub: "scoped-user" } });

      // Strict guard throws custom 403 ForbiddenException from handleRequest
      const deniedRes = await client.get("/guard-hooks/strict");
      expect(deniedRes.status).toBe(403);
      expect((await deniedRes.json<{ message: string }>()).message).toBe(
        "Denied: missing_token",
      );
    } finally {
      await mod.close();
    }

    // 3. Direct getRequest(context) override (GraphQL / WS style non-HTTP context)
    class GqlAuthGuard extends AuthGuard("scoped-token") {
      override getRequest(context: ExecutionContext) {
        return (context as unknown as { gqlReq: unknown }).gqlReq;
      }
    }

    const gqlGuard = new GqlAuthGuard();
    const fakeReq: Record<string, any> = {
      headers: { "x-scoped": "ok" },
    };
    const fakeCtx = {
      gqlReq: fakeReq,
      getHandler: () => () => {},
      getClass: () => class Dummy {},
      switchToHttp: () => ({
        getRequest: () => {
          throw new Error("Should use overridden getRequest()");
        },
        getResponse: () => undefined,
      }),
    } as unknown as ExecutionContext;

    expect(await gqlGuard.canActivate(fakeCtx)).toBe(true);
    expect(fakeReq.user).toEqual({ sub: "scoped-user" });

    // 4. logIn(request) invokes custom request.logIn callback
    let loggedInUser: unknown;
    const reqWithLogIn = {
      user: { sub: "scoped-user" },
      logIn(user: unknown, _opts: unknown, cb: (err?: unknown) => void) {
        loggedInUser = user;
        cb();
      },
    };
    await gqlGuard.logIn(reqWithLogIn);
    expect(loggedInUser).toEqual({ sub: "scoped-user" });
  });

  it("supports AbstractStrategy, PassportSerializer round-trip, and PassportModule.registerAsync (useClass & useExisting)", async () => {
    // AbstractStrategy inheritance
    class SimpleStrategy extends AbstractStrategy {
      validate(apiKey: string) {
        return apiKey === "k1" ? { id: 1 } : null;
      }
    }
    expect(new SimpleStrategy().validate("k1")).toEqual({ id: 1 });

    // PassportSerializer round-trip + logIn fallback serialization
    class UserSessionSerializer extends PassportSerializer {
      serializeUser(user: { id: string; email: string }, done: Function) {
        done(null, { uid: user.id });
      }
      deserializeUser(payload: { uid: string }, done: Function) {
        done(null, { id: payload.uid, hydrated: true });
      }
    }

    const serializer = new UserSessionSerializer();
    const passportInst = serializer.getPassportInstance();
    const serialized = await passportInst.serialize({
      id: "u-9",
      email: "ada@bunest.dev",
    });
    expect(serialized).toEqual({ uid: "u-9" });
    const restored = await passportInst.deserialize(serialized);
    expect(restored).toEqual({ id: "u-9", hydrated: true });

    // AuthGuard.logIn serializes user into request.session.passport.user when no request.logIn exists
    const GuardCls = AuthGuard("any");
    const guard = new GuardCls();
    const plainReq: Record<string, any> = {
      user: { id: "u-9", email: "ada@bunest.dev" },
    };
    await guard.logIn(plainReq as any);
    expect(plainReq.session?.passport?.user).toEqual({ uid: "u-9" });

    // PassportModule.registerAsync with useClass + AuthModuleOptions injection
    @Injectable()
    class MyAuthOptionsFactory implements AuthOptionsFactory {
      createAuthOptions(): IAuthModuleOptions {
        return { defaultStrategy: "jwt", property: "principal", session: true };
      }
    }

    @Injectable()
    class OptionsConsumer {
      constructor(
        @Inject(AuthModuleOptions) public readonly opts: IAuthModuleOptions,
      ) {}
    }

    const modClass = await Test.createTestingModule({
      imports: [
        PassportModule.registerAsync({
          useClass: MyAuthOptionsFactory,
        }),
      ],
      providers: [OptionsConsumer],
    }).compile();

    const consumer = modClass.get(OptionsConsumer);
    expect(consumer.opts.defaultStrategy).toBe("jwt");
    expect(consumer.opts.property).toBe("principal");
    expect(consumer.opts.session).toBe(true);
    await modClass.close();

    // PassportModule.registerAsync with useExisting
    @Module({
      providers: [MyAuthOptionsFactory],
      exports: [MyAuthOptionsFactory],
    })
    class SharedAuthConfigModule {}

    const modExisting = await Test.createTestingModule({
      imports: [
        PassportModule.registerAsync({
          imports: [SharedAuthConfigModule],
          useExisting: MyAuthOptionsFactory,
        }),
      ],
    }).compile();

    expect(modExisting.get(AuthModuleOptions).defaultStrategy).toBe("jwt");
    await modExisting.close();
  });
});
