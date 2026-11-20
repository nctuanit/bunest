import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  UseGuards,
  type ExecutionContext,
} from "@bunest/common";
import { getCurrentRequestContext } from "@bunest/http";
import { Test } from "@bunest/testing";
import {
  ApiKeyAuthStrategy,
  AuthGuard,
  AuthModule,
  AuthStrategyRegistry,
  BasicAuthStrategy,
  CurrentUser,
  JwksClient,
  JwksJwtAuthStrategy,
  JwksModule,
  JwtAuthStrategy,
  JwtModule,
  JwtService,
  Public,
  Roles,
  RolesGuard,
  base64UrlEncode,
  type AuthStrategy,
  type JwksKey,
} from "../src";

async function createEc256SigningPair(kid: string): Promise<{
  privateKey: CryptoKey;
  publicJwk: JwksKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JwksKey;
  return {
    privateKey: pair.privateKey,
    publicJwk: { ...exported, kid, use: "sig", alg: "ES256" },
  };
}

async function signEs256(
  privateKey: CryptoKey,
  kid: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const h = base64UrlEncode(
    JSON.stringify({ alg: "ES256", typ: "JWT", kid }),
  );
  const p = base64UrlEncode(JSON.stringify(payload));
  const input = `${h}.${p}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}

interface TestPrincipal {
  sub: string;
  authMethod: string;
  roles: string[];
}

describe("Pluggable AuthStrategyRegistry, Built-in Strategies & AuthGuard E2E", () => {
  it("manages strategies via AuthStrategyRegistry (register, get, has, list, unregister)", () => {
    const registry = new AuthStrategyRegistry();
    const custom: AuthStrategy = {
      name: "custom",
      validate: () => ({ sub: "custom-user" }),
    };

    expect(registry.has("custom")).toBe(false);
    registry.register(custom);
    expect(registry.has("custom")).toBe(true);
    expect(registry.get("custom")).toBe(custom);
    expect(registry.list()).toEqual(["custom"]);

    registry.setDefaultStrategy("custom");
    expect(registry.getDefaultStrategy()).toBe("custom");
    expect(registry.unregister("custom")).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it("enforces AuthGuard(['jwks-jwt', 'api-key']), @Public(), @Roles(), @CurrentUser(), and requestContext.user in full HTTP E2E", async () => {
    const { privateKey, publicJwk } = await createEc256SigningPair("e2e-ec-1");
    const nowSec = Math.floor(Date.now() / 1000);

    @Injectable()
    class CustomHeaderStrategy implements AuthStrategy<TestPrincipal> {
      readonly name = "custom-header";
      validate(request: Request, _ctx: ExecutionContext): TestPrincipal | null {
        const val = request.headers.get("x-custom-actor");
        if (!val) return null;
        return { sub: val, authMethod: "custom-header", roles: ["viewer"] };
      }
    }

    @Controller("/v1")
    @UseGuards(AuthGuard(["jwks-jwt", "api-key"]), RolesGuard)
    class MultiAuthController {
      @Public()
      @Get("health")
      health() {
        return { ok: true };
      }

      @Get("whoami")
      whoami(
        @CurrentUser() user: TestPrincipal,
        @CurrentUser("sub") sub: string,
      ) {
        const ctxUser = (
          getCurrentRequestContext() as { user?: TestPrincipal } | undefined
        )?.user;
        return { user, sub, ctxUserMatches: ctxUser?.sub === user.sub };
      }

      @Roles("admin")
      @Get("admin")
      adminOnly(@CurrentUser() user: TestPrincipal) {
        return { admin: user.sub, via: user.authMethod };
      }
    }

    @Controller("/alt")
    class AltAuthController {
      @UseGuards(AuthGuard("basic"))
      @Get("basic")
      basicRoute(@CurrentUser() user: { username: string; roles?: string[] }) {
        return { user };
      }

      @UseGuards(AuthGuard())
      @Get("default")
      defaultRoute(@CurrentUser() user: { sub: string }) {
        return { sub: user.sub };
      }

      @UseGuards(AuthGuard("custom-header"))
      @Get("custom")
      customRoute(@CurrentUser() user: TestPrincipal) {
        return { user };
      }
    }

    const jwksClient = new JwksClient({
      jwksUri: "https://idp.example.com/.well-known/jwks.json",
      issuer: "https://idp.example.com",
      audience: "bunest-e2e",
      fetchFn: async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: "default-jwt-secret", global: true }),
        AuthModule.register({
          defaultStrategy: "jwt",
          strategies: [
            JwtAuthStrategy,
            new JwksJwtAuthStrategy(jwksClient, {
              validate: (payload): TestPrincipal => ({
                sub: String(payload.sub),
                authMethod: "jwks-jwt",
                roles: Array.isArray(payload.roles)
                  ? (payload.roles as string[])
                  : [],
              }),
            }),
            new ApiKeyAuthStrategy({
              keys: [
                {
                  key: "sk_live_member_secret_12345",
                  principal: {
                    sub: "svc-member",
                    authMethod: "api-key",
                    roles: ["member"],
                  } satisfies TestPrincipal,
                },
                {
                  key: "sk_live_admin_secret_99999",
                  principal: {
                    sub: "svc-admin",
                    authMethod: "api-key",
                    roles: ["admin"],
                  } satisfies TestPrincipal,
                },
              ],
            }),
            new BasicAuthStrategy({
              users: [
                {
                  username: "ops",
                  password: "p@ss:with:colons!",
                  principal: { username: "ops", roles: ["admin"] },
                },
              ],
            }),
            CustomHeaderStrategy,
          ],
        }),
      ],
      controllers: [MultiAuthController, AltAuthController],
      providers: [RolesGuard],
    }).compile();

    const client = moduleRef.createTestClient();
    const jwtService = moduleRef.get(JwtService);

    const memberJwksToken = await signEs256(privateKey, "e2e-ec-1", {
      sub: "user-member",
      iss: "https://idp.example.com",
      aud: "bunest-e2e",
      roles: ["member"],
      exp: nowSec + 300,
    });
    const adminJwksToken = await signEs256(privateKey, "e2e-ec-1", {
      sub: "user-admin",
      iss: "https://idp.example.com",
      aud: "bunest-e2e",
      roles: ["admin"],
      exp: nowSec + 300,
    });
    const expiredJwksToken = await signEs256(privateKey, "e2e-ec-1", {
      sub: "user-expired",
      iss: "https://idp.example.com",
      aud: "bunest-e2e",
      roles: ["admin"],
      exp: nowSec - 60,
    });

    try {
      // 1. @Public() bypasses AuthGuard
      const healthRes = await client.get("/v1/health");
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ ok: true });

      // 2. Unauthenticated request rejected with 401
      expect((await client.get("/v1/whoami")).status).toBe(401);

      // 3. Valid JWKS Bearer JWT authenticates & attaches both @CurrentUser() and requestContext.user
      const jwtWhoami = await client
        .withBearerToken(memberJwksToken)
        .get("/v1/whoami");
      expect(jwtWhoami.status).toBe(200);
      expect(await jwtWhoami.json()).toEqual({
        user: {
          sub: "user-member",
          authMethod: "jwks-jwt",
          roles: ["member"],
        },
        sub: "user-member",
        ctxUserMatches: true,
      });

      // 4. @Roles("admin") blocks JWKS member (403) and permits JWKS admin (200)
      expect(
        (await client.withBearerToken(memberJwksToken).get("/v1/admin")).status,
      ).toBe(403);
      const adminJwtRes = await client
        .withBearerToken(adminJwksToken)
        .get("/v1/admin");
      expect(adminJwtRes.status).toBe(200);
      expect(await adminJwtRes.json()).toEqual({
        admin: "user-admin",
        via: "jwks-jwt",
      });

      // 5. Fallback to "api-key" strategy when no Bearer token is provided
      const apiKeyWhoami = await client.get("/v1/whoami", {
        headers: { "x-api-key": "sk_live_member_secret_12345" },
      });
      expect(apiKeyWhoami.status).toBe(200);
      expect(await apiKeyWhoami.json()).toEqual({
        user: {
          sub: "svc-member",
          authMethod: "api-key",
          roles: ["member"],
        },
        sub: "svc-member",
        ctxUserMatches: true,
      });

      // API key respects @Roles("admin")
      expect(
        (
          await client.get("/v1/admin", {
            headers: { "x-api-key": "sk_live_member_secret_12345" },
          })
        ).status,
      ).toBe(403);
      const adminApiKeyRes = await client.get("/v1/admin", {
        headers: { "x-api-key": "sk_live_admin_secret_99999" },
      });
      expect(adminApiKeyRes.status).toBe(200);
      expect(await adminApiKeyRes.json()).toEqual({
        admin: "svc-admin",
        via: "api-key",
      });

      // 6. Expired JWKS JWT alone -> 401; bad API key -> 401
      expect(
        (await client.withBearerToken(expiredJwksToken).get("/v1/whoami"))
          .status,
      ).toBe(401);
      expect(
        (
          await client.get("/v1/whoami", {
            headers: { "x-api-key": "sk_live_wrong_key" },
          })
        ).status,
      ).toBe(401);

      // 7. Expired JWKS JWT + valid API key -> falls through cleanly to API key!
      const fallbackRes = await client.get("/v1/whoami", {
        headers: {
          authorization: `Bearer ${expiredJwksToken}`,
          "x-api-key": "sk_live_admin_secret_99999",
        },
      });
      expect(fallbackRes.status).toBe(200);
      expect((await fallbackRes.json<{ sub: string }>()).sub).toBe("svc-admin");

      // 8. BasicAuthStrategy (with colons in password + constant-time check)
      const validBasic = Buffer.from("ops:p@ss:with:colons!").toString("base64");
      const wrongBasic = Buffer.from("ops:wrong-password").toString("base64");
      expect(
        (
          await client.get("/alt/basic", {
            headers: { authorization: `Basic ${wrongBasic}` },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await client.get("/alt/basic", {
            headers: { authorization: "Basic !!!invalid-base64!!!" },
          })
        ).status,
      ).toBe(401);
      const okBasic = await client.get("/alt/basic", {
        headers: { authorization: `Basic ${validBasic}` },
      });
      expect(okBasic.status).toBe(200);
      expect(await okBasic.json()).toEqual({
        user: { username: "ops", roles: ["admin"] },
      });

      // 9. AuthGuard() with no arguments uses defaultStrategy ("jwt")
      const defaultJwt = await jwtService.sign({ sub: "default-jwt-user" });
      expect((await client.get("/alt/default")).status).toBe(401);
      const defaultRes = await client
        .withBearerToken(defaultJwt)
        .get("/alt/default");
      expect(defaultRes.status).toBe(200);
      expect(await defaultRes.json()).toEqual({ sub: "default-jwt-user" });

      // 10. Custom DI-injectable strategy class
      const customRes = await client.get("/alt/custom", {
        headers: { "x-custom-actor": "actor-7" },
      });
      expect(customRes.status).toBe(200);
      expect(await customRes.json()).toEqual({
        user: {
          sub: "actor-7",
          authMethod: "custom-header",
          roles: ["viewer"],
        },
      });
    } finally {
      await moduleRef.close();
    }
  });

  it("supports AuthModule.registerAsync with DI-resolved JwksJwtAuthStrategy from JwksModule", async () => {
    const { privateKey, publicJwk } = await createEc256SigningPair("async-ec-1");

    @Controller("/async-auth")
    class AsyncAuthController {
      @UseGuards(AuthGuard("jwks-jwt"))
      @Get("me")
      me(@CurrentUser("sub") sub: string) {
        return { sub };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwksModule.register({
          global: true,
          jwksUri: "https://async.example.com/.well-known/jwks.json",
          fetchFn: async () =>
            new Response(JSON.stringify({ keys: [publicJwk] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
        AuthModule.registerAsync({
          useFactory: async () => {
            await Promise.resolve();
            return {
              strategies: [JwksJwtAuthStrategy],
            };
          },
        }),
      ],
      controllers: [AsyncAuthController],
    }).compile();

    const client = moduleRef.createTestClient();
    const token = await signEs256(privateKey, "async-ec-1", {
      sub: "async-jwks-user",
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    try {
      const res = await client.withBearerToken(token).get("/async-auth/me");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sub: "async-jwks-user" });
    } finally {
      await moduleRef.close();
    }
  });
});
