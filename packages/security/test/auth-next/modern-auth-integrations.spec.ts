import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  type ExecutionContext,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  ApiKeyProvider,
  Authenticate,
  AuthenticationModule,
  AuthenticationRegistry,
  BetterAuthModule,
  CurrentSession,
  CurrentUser,
  ExternalJwtAuthModule,
  InjectBetterAuth,
  Public,
  WebAuthModule,
  type ApiKeyRecord,
  type Auth0User,
  type BetterAuthLike,
  type ClerkUser,
  type SupabaseUser,
} from "../../src/auth-next/index";
import {
  AuthorizationModule,
  Can,
  Policy,
} from "../../src/authz/index";

function b64url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buf.toString("base64url");
}

async function signWebCryptoJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  alg: "RS256" | "ES256" | "HS256",
): Promise<string> {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const data = new TextEncoder().encode(signingInput);
  const algorithm =
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5" }
      : alg === "ES256"
        ? { name: "ECDSA", hash: "SHA-256" }
        : { name: "HMAC" };
  const sig = new Uint8Array(
    await crypto.subtle.sign(algorithm, privateKey, data),
  );
  return `${signingInput}.${b64url(sig)}`;
}

interface FakeBetterAuthUser {
  id: string;
  email: string;
  role: "admin" | "member";
}

interface FakeBetterAuthSession {
  id: string;
  userId: string;
  twoFactorVerified?: boolean;
}

function createMockBetterAuth(basePath = "/api/auth") {
  const sessions = new Map<
    string,
    { user: FakeBetterAuthUser; session: FakeBetterAuthSession }
  >();

  const auth: BetterAuthLike<FakeBetterAuthUser, FakeBetterAuthSession> & {
    getSessionCount(): number;
  } = {
    options: { basePath },
    getSessionCount: () => sessions.size,
    async handler(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === `${basePath}/sign-in/email`) {
        const body = (await req.json()) as {
          email: string;
          role?: "admin" | "member";
          twoFactorVerified?: boolean;
        };
        const token = `ba_tok_${sessions.size + 1}`;
        const user: FakeBetterAuthUser = {
          id: `usr_${sessions.size + 1}`,
          email: body.email,
          role: body.role ?? "member",
        };
        const session: FakeBetterAuthSession = {
          id: `sess_${sessions.size + 1}`,
          userId: user.id,
          twoFactorVerified: body.twoFactorVerified ?? false,
        };
        sessions.set(token, { user, session });

        const headers = new Headers({ "content-type": "application/json" });
        headers.append(
          "set-cookie",
          `better-auth.session_token=${token}; Path=/; HttpOnly; SameSite=Lax`,
        );
        headers.append(
          "set-cookie",
          `better-auth.csrf=csrf_123; Path=/; SameSite=Lax`,
        );
        return new Response(JSON.stringify({ user, session, token }), {
          status: 200,
          headers,
        });
      }

      if (req.method === "GET" && url.pathname === `${basePath}/callback/google`) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://app.example.com/dashboard" },
        });
      }

      if (req.method === "GET" && url.pathname === basePath) {
        return Response.json({ ok: true, provider: "better-auth" });
      }

      return Response.json({ error: "Not Found" }, { status: 404 });
    },
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const cookie = headers.get("cookie") ?? "";
        const match = /better-auth\.session_token=([^;\s]+)/.exec(cookie);
        if (match?.[1]) {
          return sessions.get(match[1]) ?? null;
        }
        const authz = headers.get("authorization");
        if (authz?.startsWith("Bearer ")) {
          return sessions.get(authz.slice(7).trim()) ?? null;
        }
        return null;
      },
    },
  };

  return auth;
}

describe("Modern Auth Integrations (@bunest/security/auth)", () => {
  describe("BetterAuthModule", () => {
    it("mounts auth.handler on /api/auth/*, preserves body & Set-Cookie headers, populates @CurrentUser/@CurrentSession/@InjectBetterAuth, and enforces ABAC @Policy/@Can", async () => {
      const auth = createMockBetterAuth("/api/auth");

      @Policy()
      class WorkspacePolicy {
        manage(user: FakeBetterAuthUser | null): boolean {
          return user?.role === "admin";
        }
      }

      @Controller("projects")
      class ProjectsController {
        constructor(
          @InjectBetterAuth()
          private readonly betterAuth: typeof auth,
        ) {}

        @Can.Anyone()
        @Get("me")
        me(
          @CurrentUser() user: FakeBetterAuthUser,
          @CurrentSession() session: FakeBetterAuthSession,
        ) {
          return {
            user,
            sessionId: session.id,
            activeSessions: this.betterAuth.getSessionCount(),
          };
        }

        @Can(WorkspacePolicy, "manage")
        @Get("admin")
        adminOnly(@CurrentUser() user: FakeBetterAuthUser) {
          return { admin: user.email };
        }

        @Can.Anyone()
        @Authenticate({ mfa: true })
        @Get("mfa-vault")
        mfaVault(@CurrentUser() user: FakeBetterAuthUser) {
          return { vaultFor: user.email };
        }

        @Public()
        @Get("health")
        health() {
          return { ok: true };
        }
      }

      @Module({
        imports: [
          BetterAuthModule.forRoot({ auth }),
          AuthorizationModule.forRoot(),
        ],
        controllers: [ProjectsController],
        providers: [WorkspacePolicy],
      })
      class AppModule {}

      const mod = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const app = mod.createBunestApplication();
      await app.init();

      try {
        // 1. Public route works
        const healthRes = await app.fetch(
          new Request("http://localhost/projects/health"),
        );
        expect(healthRes.status).toBe(200);

        // 2. Protected route rejects anonymous with 401
        const unauthRes = await app.fetch(
          new Request("http://localhost/projects/me"),
        );
        expect(unauthRes.status).toBe(401);

        // 3. Mounted Better Auth root & nested OAuth callback work
        const rootRes = await app.fetch(
          new Request("http://localhost/api/auth"),
        );
        expect(rootRes.status).toBe(200);
        expect(await rootRes.json()).toEqual({
          ok: true,
          provider: "better-auth",
        });

        const oauthRes = await app.fetch(
          new Request("http://localhost/api/auth/callback/google"),
        );
        expect(oauthRes.status).toBe(302);
        expect(oauthRes.headers.get("location")).toBe(
          "https://app.example.com/dashboard",
        );

        // 4. Sign in via POST /api/auth/sign-in/email -> unread raw body reaches auth.handler, multi Set-Cookie preserved
        const signInRes = await app.fetch(
          new Request("http://localhost/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: "alice@bunest.dev",
              role: "member",
              twoFactorVerified: false,
            }),
          }),
        );
        expect(signInRes.status).toBe(200);
        const setCookies = signInRes.headers.getSetCookie();
        expect(setCookies.length).toBeGreaterThanOrEqual(2);
        const sessionCookie = setCookies
          .find((c) => c.startsWith("better-auth.session_token="))!
          .split(";")[0]!;

        // 5. Authenticated /projects/me succeeds with @CurrentUser, @CurrentSession & @InjectBetterAuth
        const meRes = await app.fetch(
          new Request("http://localhost/projects/me", {
            headers: { cookie: sessionCookie },
          }),
        );
        expect(meRes.status).toBe(200);
        expect(await meRes.json()).toMatchObject({
          user: { email: "alice@bunest.dev", role: "member" },
          sessionId: "sess_1",
          activeSessions: 1,
        });

        // 6. ABAC @Can(WorkspacePolicy, "manage") denies member with 403
        const memberAdminRes = await app.fetch(
          new Request("http://localhost/projects/admin", {
            headers: { cookie: sessionCookie },
          }),
        );
        expect(memberAdminRes.status).toBe(403);

        // 7. @Authenticate({ mfa: true }) rejects session without twoFactorVerified
        const noMfaRes = await app.fetch(
          new Request("http://localhost/projects/mfa-vault", {
            headers: { cookie: sessionCookie },
          }),
        );
        expect(noMfaRes.status).toBe(401);

        // 8. Admin with 2FA passes both ABAC and MFA checks
        const adminSignIn = await app.fetch(
          new Request("http://localhost/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: "boss@bunest.dev",
              role: "admin",
              twoFactorVerified: true,
            }),
          }),
        );
        const adminCookie = adminSignIn.headers
          .getSetCookie()
          .find((c) => c.startsWith("better-auth.session_token="))!
          .split(";")[0]!;

        const adminOk = await app.fetch(
          new Request("http://localhost/projects/admin", {
            headers: { cookie: adminCookie },
          }),
        );
        expect(adminOk.status).toBe(200);
        expect(await adminOk.json()).toEqual({ admin: "boss@bunest.dev" });

        const mfaOk = await app.fetch(
          new Request("http://localhost/projects/mfa-vault", {
            headers: { cookie: adminCookie },
          }),
        );
        expect(mfaOk.status).toBe(200);
        expect(await mfaOk.json()).toEqual({ vaultFor: "boss@bunest.dev" });
      } finally {
        await app.close();
      }
    });

    it("supports forRootAsync() and co-exists with ApiKeyProvider when registerAuthenticationModule: false", async () => {
      const auth = createMockBetterAuth("/auth");
      const apiKeyRecords = new Map<string, ApiKeyRecord<FakeBetterAuthUser>>();

      @Injectable()
      class MachineApiKeyProvider extends ApiKeyProvider<FakeBetterAuthUser> {
        constructor(registry: AuthenticationRegistry) {
          super({ prefix: "bnst" });
          registry.registerProvider(this, { order: 10 });
        }

        protected findKey(id: string) {
          return apiKeyRecords.get(id) ?? null;
        }
      }

      @Controller("whoami")
      class WhoAmIController {
        @Get()
        who(@CurrentUser() user: FakeBetterAuthUser) {
          return { id: user.id, email: user.email };
        }
      }

      @Module({
        imports: [
          AuthenticationModule.forRoot(),
          BetterAuthModule.forRootAsync({
            basePath: "/auth",
            order: 0,
            registerAuthenticationModule: false,
            useFactory: async () => auth,
          }),
        ],
        controllers: [WhoAmIController],
        providers: [MachineApiKeyProvider],
      })
      class HybridAuthApp {}

      const mod = await Test.createTestingModule({
        imports: [HybridAuthApp],
      }).compile();
      const app = mod.createBunestApplication();
      await app.init();

      try {
        // Better Auth browser login works at custom /auth path
        const signInRes = await app.fetch(
          new Request("http://localhost/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "human@bunest.dev" }),
          }),
        );
        const cookie = signInRes.headers
          .getSetCookie()[0]!
          .split(";")[0]!;

        const humanRes = await app.fetch(
          new Request("http://localhost/whoami", {
            headers: { cookie },
          }),
        );
        expect(humanRes.status).toBe(200);
        expect(await humanRes.json()).toMatchObject({
          email: "human@bunest.dev",
        });

        // Machine API key also works in the same AuthenticationGuard chain!
        const keyProvider = app.get(MachineApiKeyProvider);
        const generated = keyProvider.generate();
        apiKeyRecords.set(generated.id, {
          hash: generated.hash,
          user: { id: "bot_1", email: "ci-bot@bunest.dev", role: "admin" },
        });

        const botRes = await app.fetch(
          new Request("http://localhost/whoami", {
            headers: { authorization: `Bearer ${generated.key}` },
          }),
        );
        expect(botRes.status).toBe(200);
        expect(await botRes.json()).toEqual({
          id: "bot_1",
          email: "ci-bot@bunest.dev",
        });
      } finally {
        await app.close();
      }
    });
  });

  describe("WebAuthModule (Auth.js & Lucia style adapters)", () => {
    it("mounts an Auth.js-style Web Request handler and resolves sessions via cookie/bearer", async () => {
      const luciaSessions = new Map<
        string,
        { user: { id: string; handle: string }; session: { id: string } }
      >([
        [
          "lucia_sess_42",
          {
            user: { id: "u_42", handle: "ada" },
            session: { id: "lucia_sess_42" },
          },
        ],
      ]);

      @Controller("profile")
      class ProfileController {
        @Get()
        getProfile(
          @CurrentUser() user: { id: string; handle: string },
          @CurrentSession() session: { id: string },
        ) {
          return { user, sessionId: session.id };
        }
      }

      @Module({
        imports: [
          WebAuthModule.forRoot({
            basePath: "/authjs",
            handler: (req) => {
              const pathname = new URL(req.url).pathname;
              if (pathname === "/authjs/providers") {
                return Response.json({ providers: ["github", "google"] });
              }
              return new Response("Not Found", { status: 404 });
            },
            getSession: ({ cookie }) => {
              const sid = cookie("auth_session");
              if (!sid) return null;
              return luciaSessions.get(sid) ?? null;
            },
          }),
        ],
        controllers: [ProfileController],
      })
      class WebAuthApp {}

      const mod = await Test.createTestingModule({
        imports: [WebAuthApp],
      }).compile();
      const app = mod.createBunestApplication();
      await app.init();

      try {
        const providersRes = await app.fetch(
          new Request("http://localhost/authjs/providers"),
        );
        expect(providersRes.status).toBe(200);
        expect(await providersRes.json()).toEqual({
          providers: ["github", "google"],
        });

        const unauth = await app.fetch(new Request("http://localhost/profile"));
        expect(unauth.status).toBe(401);

        const authed = await app.fetch(
          new Request("http://localhost/profile", {
            headers: { cookie: "auth_session=lucia_sess_42" },
          }),
        );
        expect(authed.status).toBe(200);
        expect(await authed.json()).toEqual({
          user: { id: "u_42", handle: "ada" },
          sessionId: "lucia_sess_42",
        });
      } finally {
        await app.close();
      }
    });
  });

  describe("ExternalJwtAuthModule (Clerk, Supabase, Auth0, Generic JWKS)", () => {
    it("verifies Clerk RS256 JWKS via Bearer header and __session cookie, and enforces authorizedParties (azp)", async () => {
      const rsaPair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const publicJwk = (await crypto.subtle.exportKey(
        "jwk",
        rsaPair.publicKey,
      )) as Record<string, unknown>;
      const jwksBody = JSON.stringify({
        keys: [{ ...publicJwk, kid: "clerk-k1", use: "sig", alg: "RS256" }],
      });

      const mockFetch = (async () =>
        new Response(jwksBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof globalThis.fetch;

      const issuer = "https://demo-app.clerk.accounts.dev";
      const now = Math.floor(Date.now() / 1000);

      const validToken = await signWebCryptoJwt(
        { alg: "RS256", typ: "JWT", kid: "clerk-k1" },
        {
          iss: issuer,
          sub: "user_2clerk123",
          sid: "sess_clerk_9",
          org_id: "org_acme",
          org_role: "org:admin",
          azp: "https://app.bunest.dev",
          iat: now,
          exp: now + 300,
        },
        rsaPair.privateKey,
        "RS256",
      );

      const wrongAzpToken = await signWebCryptoJwt(
        { alg: "RS256", typ: "JWT", kid: "clerk-k1" },
        {
          iss: issuer,
          sub: "user_2clerk123",
          azp: "https://evil.example.com",
          iat: now,
          exp: now + 300,
        },
        rsaPair.privateKey,
        "RS256",
      );

      @Controller("clerk")
      class ClerkController {
        @Get("me")
        me(@CurrentUser() user: ClerkUser) {
          return {
            id: user.id,
            orgId: user.orgId,
            orgRole: user.orgRole,
          };
        }
      }

      @Module({
        imports: [
          ExternalJwtAuthModule.forClerk({
            issuer,
            authorizedParties: ["https://app.bunest.dev"],
            fetch: mockFetch,
          }),
        ],
        controllers: [ClerkController],
      })
      class ClerkApp {}

      const mod = await Test.createTestingModule({
        imports: [ClerkApp],
      }).compile();
      const app = mod.createBunestApplication();
      await app.init();

      try {
        // Bearer works
        const bearerRes = await app.fetch(
          new Request("http://localhost/clerk/me", {
            headers: { authorization: `Bearer ${validToken}` },
          }),
        );
        expect(bearerRes.status).toBe(200);
        expect(await bearerRes.json()).toEqual({
          id: "user_2clerk123",
          orgId: "org_acme",
          orgRole: "org:admin",
        });

        // __session cookie fallback works
        const cookieRes = await app.fetch(
          new Request("http://localhost/clerk/me", {
            headers: { cookie: `__session=${validToken}` },
          }),
        );
        expect(cookieRes.status).toBe(200);

        // Unauthorized azp rejected with 401
        const badAzpRes = await app.fetch(
          new Request("http://localhost/clerk/me", {
            headers: { authorization: `Bearer ${wrongAzpToken}` },
          }),
        );
        expect(badAzpRes.status).toBe(401);
      } finally {
        await app.close();
      }
    });

    it("verifies Supabase Auth tokens (both asymmetric ES256 JWKS and legacy HS256 secret)", async () => {
      const ecPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const ecJwk = (await crypto.subtle.exportKey(
        "jwk",
        ecPair.publicKey,
      )) as Record<string, unknown>;
      const jwksBody = JSON.stringify({
        keys: [{ ...ecJwk, kid: "sb-es1", use: "sig", alg: "ES256" }],
      });
      const mockFetch = (async () =>
        new Response(jwksBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof globalThis.fetch;

      const projectUrl = "https://xyzproj.supabase.co";
      const now = Math.floor(Date.now() / 1000);
      const esToken = await signWebCryptoJwt(
        { alg: "ES256", typ: "JWT", kid: "sb-es1" },
        {
          iss: `${projectUrl}/auth/v1`,
          aud: "authenticated",
          sub: "sb-user-7",
          email: "dev@supabase.test",
          role: "authenticated",
          app_metadata: { plan: "pro" },
          user_metadata: { name: "Grace" },
          iat: now,
          exp: now + 300,
        },
        ecPair.privateKey,
        "ES256",
      );

      @Controller("sb")
      class SupabaseController {
        @Get("me")
        me(@CurrentUser() user: SupabaseUser) {
          return {
            id: user.id,
            email: user.email,
            plan: user.appMetadata.plan,
          };
        }
      }

      @Module({
        imports: [
          ExternalJwtAuthModule.forSupabase({
            projectUrl,
            fetch: mockFetch,
          }),
        ],
        controllers: [SupabaseController],
      })
      class SupabaseJwksApp {}

      const mod1 = await Test.createTestingModule({
        imports: [SupabaseJwksApp],
      }).compile();
      const app1 = mod1.createBunestApplication();
      await app1.init();
      try {
        const res = await app1.fetch(
          new Request("http://localhost/sb/me", {
            headers: { authorization: `Bearer ${esToken}` },
          }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          id: "sb-user-7",
          email: "dev@supabase.test",
          plan: "pro",
        });
      } finally {
        await app1.close();
      }

      // Legacy HS256 secret mode
      const secret = "supabase-legacy-jwt-secret-must-be-32-bytes!";
      const hmacKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const hsToken = await signWebCryptoJwt(
        { alg: "HS256", typ: "JWT" },
        {
          iss: `${projectUrl}/auth/v1`,
          aud: "authenticated",
          sub: "sb-legacy-9",
          email: "legacy@supabase.test",
          app_metadata: { plan: "starter" },
          iat: now,
          exp: now + 300,
        },
        hmacKey,
        "HS256",
      );

      @Module({
        imports: [
          ExternalJwtAuthModule.forSupabase({
            projectUrl,
            jwtSecret: secret,
          }),
        ],
        controllers: [SupabaseController],
      })
      class SupabaseLegacyApp {}

      const mod2 = await Test.createTestingModule({
        imports: [SupabaseLegacyApp],
      }).compile();
      const app2 = mod2.createBunestApplication();
      await app2.init();
      try {
        const res = await app2.fetch(
          new Request("http://localhost/sb/me", {
            headers: { authorization: `Bearer ${hsToken}` },
          }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          id: "sb-legacy-9",
          email: "legacy@supabase.test",
          plan: "starter",
        });
      } finally {
        await app2.close();
      }
    });

    it("verifies Auth0 RS256 JWKS tokens and extracts scope & permissions", async () => {
      const rsaPair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const publicJwk = (await crypto.subtle.exportKey(
        "jwk",
        rsaPair.publicKey,
      )) as Record<string, unknown>;
      const jwksBody = JSON.stringify({
        keys: [{ ...publicJwk, kid: "auth0-k1", use: "sig", alg: "RS256" }],
      });
      const mockFetch = (async () =>
        new Response(jwksBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof globalThis.fetch;

      const now = Math.floor(Date.now() / 1000);
      const token = await signWebCryptoJwt(
        { alg: "RS256", typ: "JWT", kid: "auth0-k1" },
        {
          iss: "https://acme.us.auth0.com/",
          aud: "https://api.acme.dev",
          sub: "auth0|507f1f77",
          scope: "openid profile read:orders",
          permissions: ["orders:read", "orders:write"],
          iat: now,
          exp: now + 300,
        },
        rsaPair.privateKey,
        "RS256",
      );

      @Controller("orders")
      class OrdersController {
        @Get(":id")
        getOrder(@Param("id") id: string, @CurrentUser() user: Auth0User) {
          return {
            id,
            caller: user.id,
            permissions: user.permissions,
            scope: user.scope,
          };
        }
      }

      @Module({
        imports: [
          ExternalJwtAuthModule.forAuth0({
            domain: "acme.us.auth0.com",
            audience: "https://api.acme.dev",
            fetch: mockFetch,
          }),
        ],
        controllers: [OrdersController],
      })
      class Auth0App {}

      const mod = await Test.createTestingModule({
        imports: [Auth0App],
      }).compile();
      const app = mod.createBunestApplication();
      await app.init();

      try {
        const res = await app.fetch(
          new Request("http://localhost/orders/ord-1", {
            headers: { authorization: `Bearer ${token}` },
          }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          id: "ord-1",
          caller: "auth0|507f1f77",
          permissions: ["orders:read", "orders:write"],
          scope: ["openid", "profile", "read:orders"],
        });
      } finally {
        await app.close();
      }
    });
  });
});
