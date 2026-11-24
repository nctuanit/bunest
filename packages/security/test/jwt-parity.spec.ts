import { describe, expect, it } from "bun:test";
import { Injectable, Module, UnauthorizedException } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  JsonWebTokenError,
  JwtExpiredException,
  JwtInvalidException,
  JwtModule,
  JwtNotBeforeException,
  JwtSecretRequestType,
  JwtService,
  NotBeforeError,
  TokenExpiredError,
  WrongSecretProviderError,
  type JwtModuleOptions,
  type JwtOptionsFactory,
} from "../src";

async function exportPem(
  key: CryptoKey,
  format: "pkcs8" | "spki",
  label: string,
): Promise<string> {
  const der = await crypto.subtle.exportKey(format, key);
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

describe("@nestjs/jwt v12 Parity (JwtService, JwtModule, Errors & Dynamic Secrets)", () => {
  it("supports signAsync & verifyAsync with object, string, and Uint8Array/Buffer payloads", async () => {
    const jwt = new JwtService({ secret: "async-parity-secret-key" });

    // 1. Plain object payload
    const objToken = await jwt.signAsync(
      { sub: "u-100", scope: "read" },
      { expiresIn: "5m", keyid: "k-1" },
    );
    const verifiedObj = await jwt.verifyAsync<{ sub: string; scope: string }>(
      objToken,
    );
    expect(verifiedObj.sub).toBe("u-100");
    expect(verifiedObj.scope).toBe("read");

    // 2. String payload
    const strToken = await jwt.signAsync("plain-text-payload");
    const verifiedStr = await jwt.verifyAsync<string>(strToken);
    expect(verifiedStr).toBe("plain-text-payload");
    expect(jwt.decode<string>(strToken)).toBe("plain-text-payload");

    // 3. Uint8Array / Buffer payload
    const binToken = await jwt.signAsync(
      Buffer.from("binary-secret-msg", "utf8"),
    );
    const verifiedBin = await jwt.verifyAsync<string>(binToken);
    expect(verifiedBin).toBe("binary-secret-msg");

    // 4. Claim sign options are rejected for non-object payloads
    await expect(
      jwt.signAsync("raw-string", { expiresIn: "1h" }),
    ).rejects.toThrow(JwtInvalidException);
    await expect(
      jwt.signAsync(new Uint8Array([1, 2, 3]), { issuer: "acme" }),
    ).rejects.toThrow(JwtInvalidException);
  });

  it("supports complete: true on verify/verifyAsync, mutatePayload, clockTimestamp, maxAge, and nonce", async () => {
    const jwt = new JwtService({ secret: "claims-parity-secret" });

    // mutatePayload: false (default) does not mutate input
    const immutableInput: Record<string, unknown> = { sub: "u1" };
    await jwt.signAsync(immutableInput, { issuer: "bunest", expiresIn: 60 });
    expect(immutableInput.iat).toBeUndefined();
    expect(immutableInput.iss).toBeUndefined();

    // mutatePayload: true mutates input in place
    const mutableInput: Record<string, unknown> = { sub: "u2", nonce: "n-xyz" };
    const token = await jwt.signAsync(mutableInput, {
      mutatePayload: true,
      issuer: "bunest",
      keyid: "key-42",
      expiresIn: 600,
    });
    expect(typeof mutableInput.iat).toBe("number");
    expect(typeof mutableInput.exp).toBe("number");
    expect(mutableInput.iss).toBe("bunest");

    // complete: true returns { header, payload, signature }
    const complete = await jwt.verifyAsync<{ sub: string; nonce: string }>(
      token,
      { complete: true, nonce: "n-xyz" },
    );
    expect(complete.header.alg).toBe("HS256");
    expect(complete.header.kid).toBe("key-42");
    expect(complete.payload.sub).toBe("u2");
    expect(complete.payload.nonce).toBe("n-xyz");
    expect(typeof complete.signature).toBe("string");
    expect(complete.signature.length).toBeGreaterThan(10);

    // nonce mismatch & blank nonce rejected
    await expect(
      jwt.verifyAsync(token, { nonce: "wrong-nonce" }),
    ).rejects.toThrow(JsonWebTokenError);
    await expect(jwt.verifyAsync(token, { nonce: "   " })).rejects.toThrow(
      JsonWebTokenError,
    );

    // clockTimestamp + maxAge enforcement
    const iat = mutableInput.iat as number;
    // Within maxAge (iat + 100s <= iat + 120s)
    const okMaxAge = await jwt.verifyAsync<{ sub: string }>(token, {
      clockTimestamp: iat + 100,
      maxAge: "2m",
    });
    expect(okMaxAge.sub).toBe("u2");

    // Beyond maxAge (iat + 125s >= iat + 120s) -> throws TokenExpiredError / JwtExpiredException
    await expect(
      jwt.verifyAsync(token, {
        clockTimestamp: iat + 125,
        maxAge: "2m",
      }),
    ).rejects.toThrow(TokenExpiredError);

    // Accepted with clockTolerance
    const tolerated = await jwt.verifyAsync<{ sub: string }>(token, {
      clockTimestamp: iat + 125,
      maxAge: "2m",
      clockTolerance: 10,
    });
    expect(tolerated.sub).toBe("u2");

    // Token without iat rejected when maxAge is requested
    const noIatToken = await jwt.signAsync(
      { sub: "no-iat" },
      { noTimestamp: true },
    );
    await expect(jwt.verifyAsync(noIatToken, { maxAge: "1m" })).rejects.toThrow(
      JsonWebTokenError,
    );
  });

  it("exports jsonwebtoken-compatible error classes sharing instanceof with Bunest exceptions", async () => {
    const jwt = new JwtService({ secret: "err-secret" });
    const nowSec = Math.floor(Date.now() / 1000);

    const expired = await jwt.signAsync({ sub: "u", exp: nowSec - 30 });
    try {
      await jwt.verifyAsync(expired);
      throw new Error("Expected verifyAsync to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenExpiredError);
      expect(err).toBeInstanceOf(JwtExpiredException);
      expect(err).toBeInstanceOf(JsonWebTokenError);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as TokenExpiredError).expiredAt).toBeInstanceOf(Date);
    }

    const future = await jwt.signAsync({ sub: "u", nbf: nowSec + 60 });
    try {
      await jwt.verifyAsync(future);
      throw new Error("Expected verifyAsync to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(NotBeforeError);
      expect(err).toBeInstanceOf(JwtNotBeforeException);
      expect(err).toBeInstanceOf(JsonWebTokenError);
      expect((err as NotBeforeError).date).toBeInstanceOf(Date);
      expect((err as JwtNotBeforeException).notBefore).toBeInstanceOf(Date);
    }

    // Direct NestJS/jsonwebtoken constructor forms
    const d = new Date("2030-01-01T00:00:00Z");
    const te = new TokenExpiredError("jwt expired", d);
    expect(te.message).toBe("jwt expired");
    expect(te.expiredAt).toEqual(d);

    const nb = new NotBeforeError("jwt not active", d);
    expect(nb.message).toBe("jwt not active");
    expect(nb.date).toEqual(d);
    expect(nb.notBefore).toEqual(d);

    const cause = new Error("inner");
    const jwe = new JsonWebTokenError("bad sig", cause);
    expect(jwe.inner).toBe(cause);

    const wspe = new WrongSecretProviderError("async provider failed");
    expect(wspe).toBeInstanceOf(Error);
    expect(wspe.name).toBe("WrongSecretProviderError");
  });

  it("supports dynamic async secretOrKeyProvider with JwtSecretRequestType, KeyObject, secretOrPrivateKey, and rejects PEM alg confusion", async () => {
    const tenantSecrets: Record<string, string> = {
      "tenant-a": "secret-for-tenant-a-32bytes!",
      "tenant-b": "secret-for-tenant-b-32bytes!",
    };
    const seenCalls: JwtSecretRequestType[] = [];

    const jwt = new JwtService({
      secretOrKeyProvider: async (requestType, tokenOrPayload) => {
        seenCalls.push(requestType);
        await Promise.resolve();
        if (requestType === JwtSecretRequestType.SIGN) {
          const tenant =
            (tokenOrPayload as { tenant?: string }).tenant ?? "tenant-a";
          return { key: tenantSecrets[tenant] ?? "" };
        }
        const decoded = jwt.decode<{ tenant?: string }>(String(tokenOrPayload));
        const tenant = decoded?.tenant ?? "tenant-a";
        const secretBuf = Buffer.from(tenantSecrets[tenant] ?? "", "utf8");
        return {
          type: "secret" as const,
          export: () => secretBuf,
        };
      },
    });

    const tokA = await jwt.signAsync({ sub: "alice", tenant: "tenant-a" });
    const tokB = await jwt.signAsync({ sub: "bob", tenant: "tenant-b" });

    expect((await jwt.verifyAsync<{ sub: string }>(tokA)).sub).toBe("alice");
    expect((await jwt.verifyAsync<{ sub: string }>(tokB)).sub).toBe("bob");
    expect(seenCalls).toEqual([
      JwtSecretRequestType.SIGN,
      JwtSecretRequestType.SIGN,
      JwtSecretRequestType.VERIFY,
      JwtSecretRequestType.VERIFY,
    ]);

    // Empty secret from provider -> WrongSecretProviderError
    const emptyProviderJwt = new JwtService({
      secretOrKeyProvider: async () => "",
    });
    await expect(emptyProviderJwt.signAsync({ sub: "x" })).rejects.toThrow(
      WrongSecretProviderError,
    );

    // Security invariant: secretOrKeyProvider returning RSA public key PEM MUST NOT verify HS256
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
    const rsaPubPem = await exportPem(rsaPair.publicKey, "spki", "PUBLIC KEY");
    const forgedHs256 = await new JwtService({ secret: rsaPubPem }).signAsync(
      { sub: "admin" },
      { algorithm: "HS256" },
    );
    const dynamicVictim = new JwtService({
      secretOrKeyProvider: () => rsaPubPem,
    });
    await expect(dynamicVictim.verifyAsync(forgedHs256)).rejects.toThrow(
      JwtInvalidException,
    );

    // Regression: Buffer/Uint8Array PEM variants (RSA PUBLIC KEY, EC PUBLIC KEY, CERTIFICATE) & asymmetric KeyObject MUST also be rejected for HMAC
    const pemVariants = [
      Buffer.from(rsaPubPem, "utf8"),
      "-----BEGIN RSA PUBLIC KEY-----\nMIIBCgKCAQEAtest\n-----END RSA PUBLIC KEY-----",
      Buffer.from(
        "-----BEGIN EC PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQc=\n-----END EC PUBLIC KEY-----",
        "utf8",
      ),
      Buffer.from(
        "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END CERTIFICATE-----",
        "utf8",
      ),
    ];
    for (const variant of pemVariants) {
      const forgedVariant = await new JwtService({ secret: variant }).signAsync(
        { sub: "admin" },
        { algorithm: "HS256" },
      );
      const victim = new JwtService({
        secretOrKeyProvider: () => variant,
      });
      await expect(victim.verifyAsync(forgedVariant)).rejects.toThrow(
        JwtInvalidException,
      );
    }

    const rsaPublicKeyObj = {
      type: "public" as const,
      export: () => rsaPubPem,
    };
    const keyObjVictim = new JwtService({
      secretOrKeyProvider: () => rsaPublicKeyObj,
    });
    await expect(keyObjVictim.verifyAsync(forgedHs256)).rejects.toThrow(
      JwtInvalidException,
    );
    const directKeyObjVictim = new JwtService({
      secret: rsaPublicKeyObj,
    });
    await expect(directKeyObjVictim.verifyAsync(forgedHs256)).rejects.toThrow(
      JwtInvalidException,
    );

    // Deprecated secretOrPrivateKey alias still works
    const legacyJwt = new JwtService({
      secretOrPrivateKey: "legacy-secret-key",
    });
    const legacyTok = await legacyJwt.signAsync({ sub: "legacy" });
    expect((await legacyJwt.verifyAsync<{ sub: string }>(legacyTok)).sub).toBe(
      "legacy",
    );
  });

  it("supports JwtModule.registerAsync with useClass, useExisting, and extraProviders", async () => {
    const SECRET_TOKEN = Symbol("CUSTOM_JWT_SECRET");

    @Injectable()
    class ConfigJwtOptionsFactory implements JwtOptionsFactory {
      createJwtOptions(): JwtModuleOptions {
        return {
          secret: "from-use-class-factory",
          signOptions: { issuer: "class-iss" },
        };
      }
    }

    const modClass = await Test.createTestingModule({
      imports: [
        JwtModule.registerAsync({
          useClass: ConfigJwtOptionsFactory,
          extraProviders: [{ provide: SECRET_TOKEN, useValue: "extra-val" }],
        }),
      ],
    }).compile();

    const jwtFromClass = modClass.get(JwtService);
    const tok1 = await jwtFromClass.signAsync({ sub: "u-class" });
    expect(
      (await jwtFromClass.verifyAsync<{ sub: string; iss: string }>(tok1)).iss,
    ).toBe("class-iss");
    expect(modClass.get(SECRET_TOKEN)).toBe("extra-val");
    await modClass.close();

    @Injectable()
    class SharedJwtFactory implements JwtOptionsFactory {
      async createJwtOptions(): Promise<JwtModuleOptions> {
        return { secret: "from-use-existing-factory" };
      }
    }

    @Module({
      providers: [SharedJwtFactory],
      exports: [SharedJwtFactory],
    })
    class SharedConfigModule {}

    const modExisting = await Test.createTestingModule({
      imports: [
        JwtModule.registerAsync({
          imports: [SharedConfigModule],
          useExisting: SharedJwtFactory,
        }),
      ],
    }).compile();

    const jwtFromExisting = modExisting.get(JwtService);
    const tok2 = await jwtFromExisting.signAsync({ sub: "u-existing" });
    expect((await jwtFromExisting.verifyAsync<{ sub: string }>(tok2)).sub).toBe(
      "u-existing",
    );
    await modExisting.close();
  });
});
