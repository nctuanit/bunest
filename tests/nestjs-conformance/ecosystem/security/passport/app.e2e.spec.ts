import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Req,
  UseGuards,
} from "../../../../../packages/core/src/common";
import {
  AuthGuard,
  JwtModule,
  JwtService,
  PassportModule,
  PassportStrategy,
  defaultPassportInstance,
} from "../../../../../packages/security/src";
import {
  createTestApp,
  describeConformance,
  type TestAppContext,
} from "../../../_helpers/index";

const JWT_SECRET = "s3cr3t";

@Injectable()
class AppService {
  private readonly users = [
    { id: "1", username: "test1", password: "test" },
    { id: "2", username: "nottest1", password: "secret" },
  ];

  constructor(private readonly jwtService: JwtService) {}

  getHello() {
    return { message: "Hello open world!" };
  }

  getPrivateMessage() {
    return { message: "Hello secure world!" };
  }

  async getToken({
    username,
    id,
  }: {
    username: string;
    id: string;
  }): Promise<{ token: string }> {
    return { token: await this.jwtService.sign({ username, id }) };
  }

  findUser({
    username,
    password,
  }: {
    username: string;
    password: string;
  }): { id: string; username: string } | null {
    const user = this.users.find((u) => u.username === username);
    if (!user || user.password !== password) {
      return null;
    }
    return user;
  }

  findUserByCookieValue(
    cookieValue: string,
  ): { id: string; username: string } | null {
    if (!cookieValue) {
      return null;
    }
    return this.users.find((u) => u.id === cookieValue) ?? null;
  }
}

/**
 * Zero-dependency Passport-local compatible base Strategy reading JSON body
 * from a cloned Web Request (ADR-001/ADR-004).
 */
class LocalBaseStrategy {
  name = "local";
  private readonly verifyFn: (
    username: string,
    password: string,
    done: (err: unknown, user?: unknown, info?: unknown) => void,
  ) => void;
  private readonly usernameField: string;
  private readonly passwordField: string;

  success!: (user: unknown, info?: unknown) => void;
  fail!: (challenge?: unknown, status?: number) => void;
  error!: (err: unknown) => void;

  constructor(
    verify: (
      username: string,
      password: string,
      done: (err: unknown, user?: unknown, info?: unknown) => void,
    ) => void,
  );
  constructor(
    options: {
      usernameField?: string;
      passwordField?: string;
      passReqToCallback?: boolean;
    },
    verify: (
      username: string,
      password: string,
      done: (err: unknown, user?: unknown, info?: unknown) => void,
    ) => void,
  );
  constructor(
    optionsOrVerify:
      | {
          usernameField?: string;
          passwordField?: string;
          passReqToCallback?: boolean;
        }
      | ((
          username: string,
          password: string,
          done: (err: unknown, user?: unknown, info?: unknown) => void,
        ) => void),
    verify?: (
      username: string,
      password: string,
      done: (err: unknown, user?: unknown, info?: unknown) => void,
    ) => void,
  ) {
    if (typeof optionsOrVerify === "function") {
      this.usernameField = "username";
      this.passwordField = "password";
      this.verifyFn = optionsOrVerify;
    } else {
      this.usernameField = optionsOrVerify?.usernameField ?? "username";
      this.passwordField = optionsOrVerify?.passwordField ?? "password";
      this.verifyFn = verify!;
    }
  }

  async authenticate(req: Request) {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.clone().json()) as Record<string, unknown>;
    } catch {
      return this.fail({ message: "Missing credentials" }, 400);
    }

    const username = body[this.usernameField];
    const password = body[this.passwordField];
    if (typeof username !== "string" || typeof password !== "string") {
      return this.fail({ message: "Missing credentials" }, 400);
    }

    this.verifyFn(username, password, (err, user, info) => {
      if (err) return this.error(err);
      if (!user) return this.fail(info ?? { message: "Unauthorized" }, 401);
      return this.success(user, info);
    });
  }
}

/**
 * Zero-dependency Passport-jwt compatible base Strategy verifying Bearer JWTs via Bunest JwtService.
 */
class JwtBaseStrategy {
  name = "jwt";
  private readonly secretOrKey: string;
  private readonly passReqToCallback: boolean;
  private readonly verifyFn: (...args: unknown[]) => void;

  success!: (user: unknown, info?: unknown) => void;
  fail!: (challenge?: unknown, status?: number) => void;
  error!: (err: unknown) => void;

  constructor(
    options: { secretOrKey: string; passReqToCallback?: boolean },
    verify: (...args: unknown[]) => void,
  ) {
    this.secretOrKey = options.secretOrKey;
    this.passReqToCallback = options.passReqToCallback ?? false;
    this.verifyFn = verify;
  }

  async authenticate(req: Request) {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return this.fail({ message: "No auth token" }, 401);
    }
    const token = authHeader.slice("Bearer ".length).trim();
    const jwt = new JwtService({ secret: this.secretOrKey });
    let payload: Record<string, unknown>;
    try {
      payload = await jwt.verify<Record<string, unknown>>(token);
    } catch (err) {
      return this.fail(err, 401);
    }

    const done = (err: unknown, user?: unknown, info?: unknown) => {
      if (err) return this.error(err);
      if (!user) return this.fail(info ?? { message: "Unauthorized" }, 401);
      return this.success(user, info);
    };

    if (this.passReqToCallback) {
      this.verifyFn(req, payload, done);
    } else {
      this.verifyFn(payload, done);
    }
  }
}

@Injectable()
class LocalStrategy extends PassportStrategy(LocalBaseStrategy, "local") {
  constructor(private readonly appService: AppService) {
    super();
  }

  validate(username: string, password: string) {
    return this.appService.findUser({ username, password });
  }
}

@Injectable()
class JwtStrategy extends PassportStrategy(JwtBaseStrategy, "jwt") {
  constructor() {
    super({
      secretOrKey: JWT_SECRET,
      passReqToCallback: true,
    });
  }

  validate(_req: Request, payload: Record<string, unknown>) {
    return { id: payload.id, username: payload.username };
  }
}

@Controller()
class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello() {
    return this.appService.getHello();
  }

  @UseGuards(AuthGuard("jwt"))
  @Get("private")
  getPrivateHello() {
    return this.appService.getPrivateMessage();
  }

  @UseGuards(AuthGuard("local"))
  @Post("login")
  async login(
    @Req() req: Request & { user?: { id: string } },
    @Body() body: Record<string, string>,
  ) {
    return this.appService.getToken({
      username: body.username ?? "",
      id: req.user?.id ?? "",
    });
  }
}

@Module({
  controllers: [AppController],
  imports: [
    JwtModule.register({ secret: JWT_SECRET }),
    PassportModule.register({}),
  ],
  providers: [AppService, LocalStrategy, JwtStrategy],
})
class WithRegisterModule {}

@Module({
  controllers: [AppController],
  imports: [JwtModule.register({ secret: JWT_SECRET }), PassportModule],
  providers: [AppService, LocalStrategy, JwtStrategy],
})
class WithoutRegisterModule {}

@Injectable()
class OptionsCheckStrategy {
  name = "options-check";

  success!: (user: unknown, info?: unknown) => void;
  fail!: (challenge?: unknown, status?: number) => void;

  constructor() {
    defaultPassportInstance.use(this);
  }

  authenticate(_req: Request, options: Record<string, unknown>) {
    const leakedOptionKeys = ["defaultStrategy", "property"].filter(
      (key) => key in options,
    );

    if (leakedOptionKeys.length > 0) {
      return this.fail(
        { message: `Leaked options: ${leakedOptionKeys.join(", ")}` },
        401,
      );
    }

    return this.success(
      { id: "account-1" },
      {
        receivedSessionOption: options.session,
      },
    );
  }
}

@Controller()
class OptionsCheckController {
  @UseGuards(AuthGuard())
  @Get("options-check")
  checkOptions(
    @Req()
    req: Request & {
      account?: unknown;
      authInfo?: unknown;
      user?: unknown;
    },
  ) {
    return {
      account: req.account,
      authInfo: req.authInfo,
      user: req.user ?? null,
    };
  }
}

@Module({
  controllers: [OptionsCheckController],
  imports: [
    PassportModule.register({
      defaultStrategy: "options-check",
      property: "account",
      session: false,
    }),
  ],
  providers: [OptionsCheckStrategy],
})
class OptionsCheckModule {}

describeConformance(
  "Passport Module E2E",
  {
    upstreamPath: "passport/test/common/app.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-004"],
    notes:
      "Upstream commit 19422a37af (@nestjs/passport@12.0.2). Uses Bunest zero-dependency PassportModule, PassportStrategy, AuthGuard, and WebCrypto JwtService without passport/passport-local/passport-jwt npm packages.",
  },
  () => {
    describe.each([
      { AppModule: WithRegisterModule, RegisterUse: "with" },
      { AppModule: WithoutRegisterModule, RegisterUse: "without" },
    ])("Passport Module $RegisterUse register()", ({ AppModule }) => {
      let ctx: TestAppContext;

      beforeAll(async () => {
        defaultPassportInstance.clear();
        ctx = await createTestApp(
          { imports: [AppModule] },
          { silentLogger: true },
        );
      });

      afterAll(async () => {
        await ctx.close();
        defaultPassportInstance.clear();
      });

      describe("Authenticated flow", () => {
        it("should be able to log in and get a jwt, then hit the secret route", async () => {
          const loginRes = await ctx
            .request()
            .post("/login")
            .send({ username: "test1", password: "test" })
            .expect(201);

          const token = (loginRes.body as { token?: string }).token;
          expect(typeof token).toBe("string");
          expect(token!.length).toBeGreaterThan(0);

          const privateRes = await ctx
            .request()
            .get("/private")
            .set("Authorization", `Bearer ${token}`)
            .expect(200);

          expect(privateRes.body).toEqual({ message: "Hello secure world!" });
        });
      });

      describe("UnauthenticatedFlow", () => {
        it("should return a 401 for an invalid login", async () => {
          await ctx
            .request()
            .post("/login")
            .send({ username: "test1", password: "not the right password" })
            .expect(401);
        });

        it("should return a 401 for an invalid JWT", async () => {
          await ctx
            .request()
            .get("/private")
            .set("Authorization", "Bearer not-a-jwt")
            .expect(401);
        });
      });
    });

    describe("Passport authenticate options", () => {
      let ctx: TestAppContext;

      beforeAll(async () => {
        defaultPassportInstance.clear();
        ctx = await createTestApp(
          { imports: [OptionsCheckModule] },
          { silentLogger: true },
        );
      });

      afterAll(async () => {
        await ctx.close();
        defaultPassportInstance.clear();
      });

      it("should not pass module-only options to the strategy", async () => {
        const res = await ctx.request().get("/options-check").expect(200);
        expect(res.body).toEqual({
          account: { id: "account-1" },
          authInfo: { receivedSessionOption: false },
          user: null,
        });
      });
    });
  },
);
