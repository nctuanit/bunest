import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Controller, Get, Injectable, Req, UseGuards } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  AUTH_MODULE_OPTIONS,
  AbstractStrategy,
  AuthGuard,
  AuthModuleOptions,
  AuthStrategyRegistry,
  BunestPassportInstance,
  PassportModule,
  PassportSerializer,
  PassportStrategy,
  defaultPassportInstance,
  type AuthGuardAuthenticateOptions,
  type AuthModuleAsyncOptions,
  type AuthOptionsFactory,
  type IAuthGuard,
  type IAuthModuleOptions,
} from "../src";

class HeaderPassportBase {
  public name = "header-token";
  private readonly verifyFn: (...args: any[]) => void;
  private readonly header: string;

  constructor(options: { header: string }, verify: (...args: any[]) => void) {
    this.header = options.header;
    this.verifyFn = verify;
  }

  authenticate(
    this: HeaderPassportBase & {
      success: (user: any, info?: any) => void;
      fail: (info?: any, status?: number) => void;
      error: (err: any) => void;
    },
    req: Request,
  ) {
    const token = req.headers.get(this.header);
    if (!token) {
      this.fail({ message: "missing" }, 401);
      return;
    }
    this.verifyFn(token, (err: any, user?: any, info?: any) => {
      if (err) return this.error(err);
      if (!user) return this.fail(info ?? { message: "invalid" }, 401);
      this.success(user, info);
    });
  }
}

afterEach(() => {
  defaultPassportInstance.clear();
});

describe("@bunest/passport drop-in facade (@nestjs/passport v12 parity)", () => {
  it("exports all 6 @nestjs/passport@12.0.2 runtime values and Bunest helpers", () => {
    expect(AbstractStrategy).toBeDefined();
    expect(typeof AuthGuard).toBe("function");
    expect(AuthModuleOptions).toBeDefined();
    expect(PassportModule).toBeDefined();
    expect(PassportSerializer).toBeDefined();
    expect(typeof PassportStrategy).toBe("function");
    expect(AuthStrategyRegistry).toBeDefined();
    expect(BunestPassportInstance).toBeDefined();
    expect(defaultPassportInstance).toBeInstanceOf(BunestPassportInstance);
    expect(typeof AUTH_MODULE_OPTIONS).toBe("symbol");
  });

  it("registers PassportModule, PassportStrategy, and AuthGuard on HTTP routes", async () => {
    @Injectable()
    class ApiTokenStrategy extends PassportStrategy(HeaderPassportBase, "api-token") {
      constructor() {
        super({ header: "x-api-token" });
      }

      validate(token: string) {
        return token === "secret-123" ? { id: "u-1", name: "Ada" } : null;
      }
    }

    @Injectable()
    class CustomTokenGuard extends AuthGuard("api-token") implements IAuthGuard {
      override getAuthenticateOptions(): AuthGuardAuthenticateOptions {
        return { session: false };
      }
    }

    @Controller("/profile")
    class ProfileController {
      @UseGuards(CustomTokenGuard)
      @Get()
      getProfile(@Req() req: Request & { user?: { id: string; name: string } }) {
        return { user: req.user };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: "api-token" })],
      controllers: [ProfileController],
      providers: [ApiTokenStrategy, CustomTokenGuard],
    }).compile();

    const client = mod.createTestClient();
    try {
      expect((await client.get("/profile")).status).toBe(401);

      const okRes = await client.get("/profile", {
        headers: { "x-api-token": "secret-123" },
      });
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toEqual({ user: { id: "u-1", name: "Ada" } });
    } finally {
      await mod.close();
    }
  });

  it("supports AbstractStrategy, PassportSerializer, and PassportModule.registerAsync()", async () => {
    class LocalCheck extends AbstractStrategy {
      validate(code: string) {
        return code === "ok" ? { valid: true } : false;
      }
    }
    expect(new LocalCheck().validate("ok")).toEqual({ valid: true });

    class SessionSerializer extends PassportSerializer {
      serializeUser(user: { id: string }, done: Function) {
        done(null, user.id);
      }
      deserializeUser(id: string, done: Function) {
        done(null, { id, restored: true });
      }
    }

    const serializer = new SessionSerializer();
    const id = await serializer.getPassportInstance().serialize({ id: "u-42" });
    expect(id).toBe("u-42");
    expect(await serializer.getPassportInstance().deserialize(id)).toEqual({
      id: "u-42",
      restored: true,
    });

    @Injectable()
    class PassportFactory implements AuthOptionsFactory {
      createAuthOptions(): IAuthModuleOptions {
        return { defaultStrategy: "jwt", property: "principal" };
      }
    }

    const asyncOpts: AuthModuleAsyncOptions = { useClass: PassportFactory };
    const mod = await Test.createTestingModule({
      imports: [PassportModule.registerAsync(asyncOpts)],
    }).compile();

    try {
      const opts = mod.get(AuthModuleOptions);
      expect(opts.defaultStrategy).toBe("jwt");
      expect(opts.property).toBe("principal");
    } finally {
      await mod.close();
    }
  });
});
