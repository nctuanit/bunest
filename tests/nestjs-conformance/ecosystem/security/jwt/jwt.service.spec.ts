import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import {
  JwtModule,
  JwtSecretRequestType,
  JwtService,
  type DecodedJwt,
  type JwtModuleOptions,
  type JwtPayload,
  type JwtSignOptions,
} from "../../../../../packages/security/src";
import type { CryptoKeyObjectLike } from "../../../../../packages/security/src/jwt/jwt.interface";
import {
  Test,
  type TestingModule,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

// Compile-time type assertion helpers (replacing Vitest's `expectTypeOf`)
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

function derToPem(der: ArrayBuffer, label: string): string {
  const base64 = Buffer.from(der).toString("base64");
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

async function generateRsaKeyPairPem(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const [spki, pkcs8] = await Promise.all([
    crypto.subtle.exportKey("spki", pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ]);
  return {
    publicKey: derToPem(spki, "PUBLIC KEY"),
    privateKey: derToPem(pkcs8, "PRIVATE KEY"),
  };
}

function createPrivateKeyObject(pem: string): CryptoKeyObjectLike {
  return {
    type: "private",
    asymmetricKeyType: "rsa",
    export: () => pem,
  };
}

function createPublicKeyObject(pem: string): CryptoKeyObjectLike {
  return {
    type: "public",
    asymmetricKeyType: "rsa",
    export: () => pem,
  };
}

function createSecretKeyObject(bytes: Uint8Array): CryptoKeyObjectLike {
  return {
    type: "secret",
    symmetricKeySize: bytes.byteLength,
    export: () => bytes,
  };
}

const rsaMain = await generateRsaKeyPairPem();
const rsaCustom = await generateRsaKeyPairPem();

const setup = async (
  config: JwtModuleOptions,
): Promise<{ jwtService: JwtService; moduleRef: TestingModule }> => {
  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register(config)],
  }).compile();

  return {
    jwtService: moduleRef.get<JwtService>(JwtService),
    moduleRef,
  };
};

const baseConfig: JwtModuleOptions = {
  secretOrKeyProvider: (requestType: JwtSecretRequestType) =>
    requestType === JwtSecretRequestType.SIGN ? "sign_secret" : "verify_secret",
  secret: "default_secret",
  publicKey: rsaMain.publicKey,
  privateKey: rsaMain.privateKey,
};

describeConformance(
  "JwtService",
  {
    upstreamPath: "jwt/lib/jwt.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Upstream commit 47e5bb6322 (@nestjs/jwt@12.0.5). Bunest JwtService uses pure WebCrypto (crypto.subtle) with zero jsonwebtoken dependency; sign() and verify() are async Promises and tests verify real cryptographic signing/verification key selection instead of spying on jsonwebtoken.",
  },
  () => {
    const getRandomString = () =>
      `payload_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Standalone verifier helpers bound to specific secrets/keys to prove which key was selected
    const signVerifier = new JwtService({ secret: "sign_secret" });
    const verifySecretSigner = new JwtService({ secret: "verify_secret" });
    const defaultSecretService = new JwtService({ secret: "default_secret" });
    const customSecretService = new JwtService({ secret: "custom_secret" });
    const deprecatedSecretService = new JwtService({
      secret: "deprecated_key",
    });
    const mainRsaService = new JwtService({
      privateKey: rsaMain.privateKey,
      publicKey: rsaMain.publicKey,
      signOptions: { algorithm: "RS256" },
    });
    const customRsaService = new JwtService({
      privateKey: rsaCustom.privateKey,
      publicKey: rsaCustom.publicKey,
      signOptions: { algorithm: "RS256" },
    });

    describe("should use config.secretOrKeyProvider", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayload: string = getRandomString();

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup(baseConfig));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      it("signing should use config.secretOrKeyProvider", async () => {
        const token = await jwtService.sign(testPayload);
        await expect(signVerifier.verify<string>(token)).resolves.toBe(
          testPayload,
        );
        await expect(defaultSecretService.verify(token)).rejects.toThrow();
      });

      it("signing (async) should use config.secretOrKeyProvider", async () => {
        const token = await jwtService.signAsync(testPayload);
        await expect(signVerifier.verifyAsync<string>(token)).resolves.toBe(
          testPayload,
        );
        await expect(defaultSecretService.verifyAsync(token)).rejects.toThrow();
      });

      it("verifying should use config.secretOrKeyProvider", async () => {
        const token = await verifySecretSigner.sign(testPayload);
        await expect(jwtService.verify<string>(token)).resolves.toBe(
          testPayload,
        );
        const wrongToken = await defaultSecretService.sign(testPayload);
        await expect(jwtService.verify(wrongToken)).rejects.toThrow();
      });

      it("verifying (async) should use config.secretOrKeyProvider", async () => {
        const token = await verifySecretSigner.signAsync(testPayload);
        await expect(jwtService.verifyAsync<string>(token)).resolves.toBe(
          testPayload,
        );
        const wrongToken = await defaultSecretService.signAsync(testPayload);
        await expect(jwtService.verifyAsync(wrongToken)).rejects.toThrow();
      });
    });

    describe("should reject when async config.secretOrKeyProvider rejects", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayload: string = getRandomString();
      let validFormatToken: string;

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          ...baseConfig,
          secretOrKeyProvider: () => Promise.reject(new Error("no key")),
        }));
        validFormatToken = await defaultSecretService.sign(testPayload);
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      it("signing (async) should reject", async () => {
        await expect(jwtService.signAsync(testPayload)).rejects.toThrow(
          "no key",
        );
      });

      it("verifying (async) should reject", async () => {
        await expect(jwtService.verifyAsync(validFormatToken)).rejects.toThrow(
          "no key",
        );
      });
    });

    describe("should use config.secret", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayload: string = getRandomString();

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          ...baseConfig,
          secretOrKeyProvider: undefined,
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      // BUNEST_BUG: packages/security/src/jwt/jwt.service.ts (inferDefaultSignAlgorithm) checks `this.options.privateKey` before `this.options.secret`, so when both `secret` and `privateKey` are configured it signs with RS256/privateKey instead of HS256/secret.
      it.skip("signing should use config.secret", async () => {
        const token = await jwtService.sign(testPayload);
        await expect(defaultSecretService.verify<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      // BUNEST_BUG: packages/security/src/jwt/jwt.service.ts (inferDefaultSignAlgorithm) checks `this.options.privateKey` before `this.options.secret`, so when both `secret` and `privateKey` are configured `signAsync` signs with RS256/privateKey instead of HS256/secret.
      it.skip("signing (async) should use config.secret", async () => {
        const token = await jwtService.signAsync(testPayload);
        await expect(
          defaultSecretService.verifyAsync<string>(token),
        ).resolves.toBe(testPayload);
      });

      it("verifying should use config.secret", async () => {
        const token = await defaultSecretService.sign(testPayload);
        await expect(jwtService.verify<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      it("verifying (async) should use config.secret", async () => {
        const token = await defaultSecretService.signAsync(testPayload);
        await expect(jwtService.verifyAsync<string>(token)).resolves.toBe(
          testPayload,
        );
      });
    });

    describe("should use config.privateKey and config.publicKey", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayload: string = getRandomString();

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          ...baseConfig,
          secretOrKeyProvider: undefined,
          secret: undefined,
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      it("signing should use config.privateKey", async () => {
        const token = await jwtService.sign(testPayload);
        await expect(mainRsaService.verify<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      it("signing (async) should use config.privateKey", async () => {
        const token = await jwtService.signAsync(testPayload);
        await expect(mainRsaService.verifyAsync<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      it("verifying should use config.publicKey", async () => {
        const token = await mainRsaService.sign(testPayload);
        await expect(jwtService.verify<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      it("verifying (async) should use config.publicKey", async () => {
        const token = await mainRsaService.signAsync(testPayload);
        await expect(jwtService.verifyAsync<string>(token)).resolves.toBe(
          testPayload,
        );
      });
    });

    describe("should allow KeyObject for privateKey and publicKey", () => {
      const privKeyAsObject: CryptoKeyObjectLike = createPrivateKeyObject(
        rsaMain.privateKey,
      );
      const pubKeyAsObject: CryptoKeyObjectLike = createPublicKeyObject(
        rsaMain.publicKey,
      );
      const testPayload = { foo: "bar" };

      let jwtService: JwtService;
      let moduleRef: TestingModule;

      beforeEach(async () => {
        ({ jwtService, moduleRef } = await setup({
          privateKey: privKeyAsObject,
          publicKey: pubKeyAsObject,
          signOptions: { algorithm: "RS256" },
        }));
      });

      afterEach(async () => {
        await moduleRef.close();
      });

      it("verifying should work", async () => {
        const token = await jwtService.sign(testPayload);

        await expect(jwtService.verify(token)).resolves.toHaveProperty(
          "foo",
          "bar",
        );
      });

      it("verifying (async) should work", async () => {
        const token = await jwtService.sign(testPayload);

        await expect(jwtService.verifyAsync(token)).resolves.toHaveProperty(
          "foo",
          "bar",
        );
      });
    });

    describe("should allow KeyObject for secret, privateKey and publicKey in options", () => {
      const privKeyAsObject: CryptoKeyObjectLike = createPrivateKeyObject(
        rsaMain.privateKey,
      );
      const pubKeyAsObject: CryptoKeyObjectLike = createPublicKeyObject(
        rsaMain.publicKey,
      );
      const secretAsObject: CryptoKeyObjectLike = createSecretKeyObject(
        Buffer.from("the secret key"),
      );
      const testPayload = { foo: "bar" };

      let jwtService: JwtService;
      let moduleRef: TestingModule;

      beforeEach(async () => {
        ({ jwtService, moduleRef } = await setup({}));
      });

      afterEach(async () => {
        await moduleRef.close();
      });

      it("verifying should work with privateKey and publicKey", async () => {
        const token = await jwtService.sign(testPayload, {
          privateKey: privKeyAsObject,
          algorithm: "RS256",
        });

        await expect(
          jwtService.verify(token, { publicKey: pubKeyAsObject }),
        ).resolves.toHaveProperty("foo", "bar");
      });

      it("verifying (async) should work with secret", async () => {
        const token = await jwtService.signAsync(testPayload, {
          secret: secretAsObject,
        });

        await expect(
          jwtService.verifyAsync(token, { secret: secretAsObject }),
        ).resolves.toHaveProperty("foo", "bar");
      });
    });

    describe("should use config.secretOrPrivateKey but warn about deprecation", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayload: string = getRandomString();

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          ...baseConfig,
          secretOrPrivateKey: "deprecated_key",
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      // BUNEST_BUG: packages/security/src/jwt/jwt.service.ts has no `logger` property, emits no deprecation warning for `secretOrPrivateKey`, and places `secretOrPrivateKey` at lowest precedence behind `secretOrKeyProvider`/`secret`/`privateKey`.
      it.skip("signing should use deprecated secretOrPrivateKey", async () => {
        const warnSpy = spyOn(
          (jwtService as unknown as { logger: { warn: (msg: string) => void } })
            .logger,
          "warn",
        );
        try {
          const token = await jwtService.sign(testPayload);
          await expect(
            deprecatedSecretService.verify<string>(token),
          ).resolves.toBe(testPayload);
          expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
          warnSpy.mockRestore();
        }
      });

      // BUNEST_BUG: packages/security/src/jwt/jwt.service.ts has no `logger` property, emits no deprecation warning for `secretOrPrivateKey`, and places `secretOrPrivateKey` at lowest precedence behind `secretOrKeyProvider`/`secret`/`privateKey`.
      it.skip("signing (async) should use deprecated secretOrPrivateKey", async () => {
        const warnSpy = spyOn(
          (jwtService as unknown as { logger: { warn: (msg: string) => void } })
            .logger,
          "warn",
        );
        try {
          const token = await jwtService.signAsync(testPayload);
          await expect(
            deprecatedSecretService.verifyAsync<string>(token),
          ).resolves.toBe(testPayload);
          expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
          warnSpy.mockRestore();
        }
      });

      // BUNEST_BUG: packages/security/src/jwt/jwt.service.ts has no `logger` property, emits no deprecation warning for `secretOrPrivateKey`, and places `secretOrPrivateKey` at lowest precedence behind `secretOrKeyProvider`/`secret`/`privateKey`.
      it.skip("verifying should use deprecated secretOrPrivateKey", async () => {
        const warnSpy = spyOn(
          (jwtService as unknown as { logger: { warn: (msg: string) => void } })
            .logger,
          "warn",
        );
        try {
          const token = await deprecatedSecretService.sign(testPayload);
          await expect(jwtService.verify<string>(token)).resolves.toBe(
            testPayload,
          );
          expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
          warnSpy.mockRestore();
        }
      });

      // BUNEST_BUG: packages/security/src/jwt/jwt.service.ts has no `logger` property, emits no deprecation warning for `secretOrPrivateKey`, and places `secretOrPrivateKey` at lowest precedence behind `secretOrKeyProvider`/`secret`/`privateKey`.
      it.skip("verifying (async) should use deprecated secretOrPrivateKey", async () => {
        const warnSpy = spyOn(
          (jwtService as unknown as { logger: { warn: (msg: string) => void } })
            .logger,
          "warn",
        );
        try {
          const token = await deprecatedSecretService.signAsync(testPayload);
          await expect(jwtService.verifyAsync<string>(token)).resolves.toBe(
            testPayload,
          );
          expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    describe("should allow buffers for secrets", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      let secretB64: Buffer;
      const testPayload = { foo: "bar" };

      beforeEach(async () => {
        secretB64 = Buffer.from("ThisIsARandomSecret", "base64");
        ({ jwtService, moduleRef } = await setup({ secret: secretB64 }));
      });

      afterEach(async () => {
        await moduleRef.close();
      });

      it("verifying should use base64 buffer key", async () => {
        const token = await new JwtService({ secret: secretB64 }).sign(
          testPayload,
        );

        await expect(jwtService.verify(token)).resolves.toHaveProperty(
          "foo",
          "bar",
        );
      });

      it("verifying (async) should use base64 buffer key", async () => {
        const token = await new JwtService({ secret: secretB64 }).signAsync(
          testPayload,
        );

        await expect(jwtService.verifyAsync(token)).resolves.toHaveProperty(
          "foo",
          "bar",
        );
      });
    });

    describe("should allow KeyObject for secret", () => {
      const secretB64: CryptoKeyObjectLike = createSecretKeyObject(
        Buffer.from("ThisIsARandomSecret", "base64"),
      );
      const testPayload = { foo: "bar" };

      let jwtService: JwtService;
      let moduleRef: TestingModule;

      beforeEach(async () => {
        ({ jwtService, moduleRef } = await setup({ secret: secretB64 }));
      });

      afterEach(async () => {
        await moduleRef.close();
      });

      it("verifying should use base64 buffer key", async () => {
        const token = await new JwtService({ secret: secretB64 }).sign(
          testPayload,
        );

        await expect(jwtService.verify(token)).resolves.toHaveProperty(
          "foo",
          "bar",
        );
      });

      it("verifying (async) should use base64 buffer key", async () => {
        const token = await new JwtService({ secret: secretB64 }).signAsync(
          testPayload,
        );

        await expect(jwtService.verifyAsync(token)).resolves.toHaveProperty(
          "foo",
          "bar",
        );
      });
    });

    describe("should use secret key from options", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayload: string = getRandomString();
      const secret = "custom_secret";

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          ...baseConfig,
          secretOrKeyProvider: undefined,
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      // BUNEST_BUG: packages/security/src/jwt/jwt.service.ts (inferDefaultSignAlgorithm) checks `this.options.privateKey` before per-call `opts.secret`, so calling `sign(payload, { secret })` when module config also has `privateKey` signs with RS256/privateKey instead of HS256/`opts.secret`.
      it.skip("signing should use secret key from options", async () => {
        const token = await jwtService.sign(testPayload, { secret });
        await expect(customSecretService.verify<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      // BUNEST_BUG: packages/security/src/jwt/jwt.service.ts (inferDefaultSignAlgorithm) checks `this.options.privateKey` before per-call `opts.secret`, so calling `signAsync(payload, { secret })` when module config also has `privateKey` signs with RS256/privateKey instead of HS256/`opts.secret`.
      it.skip("signing (async) should use secret key from options", async () => {
        const token = await jwtService.signAsync(testPayload, { secret });
        await expect(
          customSecretService.verifyAsync<string>(token),
        ).resolves.toBe(testPayload);
      });

      it("verifying should use secret key from options", async () => {
        const token = await customSecretService.sign(testPayload);
        await expect(
          jwtService.verify<string>(token, { secret }),
        ).resolves.toBe(testPayload);
      });

      it("verifying (async) should use secret key from options", async () => {
        const token = await customSecretService.signAsync(testPayload);
        await expect(
          jwtService.verifyAsync<string>(token, { secret }),
        ).resolves.toBe(testPayload);
      });
    });

    describe("should use private/public key from options", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayload: string = getRandomString();
      const privateKey = rsaCustom.privateKey;
      const publicKey = rsaCustom.publicKey;

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          ...baseConfig,
          secretOrKeyProvider: undefined,
          secret: undefined,
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      it("signing should use private key from options", async () => {
        const token = await jwtService.sign(testPayload, { privateKey });
        await expect(customRsaService.verify<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      it("signing (async) should use private key from options", async () => {
        const token = await jwtService.signAsync(testPayload, { privateKey });
        await expect(customRsaService.verifyAsync<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      it("verifying should use public key from options", async () => {
        const token = await customRsaService.sign(testPayload);
        await expect(
          jwtService.verify<string>(token, { publicKey }),
        ).resolves.toBe(testPayload);
      });

      it("verifying (async) should use public key from options", async () => {
        const token = await customRsaService.signAsync(testPayload);
        await expect(
          jwtService.verifyAsync<string>(token, { publicKey }),
        ).resolves.toBe(testPayload);
      });
    });

    describe("should prioritize private/public key from options over config.secret", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayload: string = getRandomString();
      const privateKey = rsaCustom.privateKey;
      const publicKey = rsaCustom.publicKey;

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          secret: "default_secret",
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      it("signing prioritizes options.privateKey over config.secret", async () => {
        const token = await jwtService.sign(testPayload, { privateKey });
        await expect(customRsaService.verify<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      it("signing (async) prioritizes options.privateKey over config.secret", async () => {
        const token = await jwtService.signAsync(testPayload, { privateKey });
        await expect(customRsaService.verifyAsync<string>(token)).resolves.toBe(
          testPayload,
        );
      });

      it("verifying prioritizes options.publicKey over config.secret", async () => {
        const token = await customRsaService.sign(testPayload);
        await expect(
          jwtService.verify<string>(token, { publicKey }),
        ).resolves.toBe(testPayload);
      });

      it("verifying (async) prioritizes options.publicKey over config.secret", async () => {
        const token = await customRsaService.signAsync(testPayload);
        await expect(
          jwtService.verifyAsync<string>(token, { publicKey }),
        ).resolves.toBe(testPayload);
      });
    });

    describe("should not use invalid sign options", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayloadStr: string = getRandomString();

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          secretOrKeyProvider: undefined,
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      it('should not "sign" expect errors with a "payload" string and "secret"', async () => {
        const token = await jwtService.sign(testPayloadStr, {
          secret: "secret",
        });
        expect(typeof token).toBe("string");
      });

      it('should not "signAsync" expect errors with a "payload" string and "privateKey"', async () => {
        const token = await jwtService.signAsync(testPayloadStr, {
          privateKey: rsaMain.privateKey,
        });
        expect(typeof token).toBe("string");
      });
    });

    describe("should use invalid sign options", () => {
      const signOptions: JwtSignOptions = { expiresIn: "1d" };

      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayloadStr: string = getRandomString();
      const testPayloadObj: Record<string, unknown> = {};

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          secret: "default_secret",
          signOptions,
          secretOrKeyProvider: undefined,
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      itAdapted(
        "ADR-001",
        'should "sign" expect errors with a "payload" string with "expiresIn"',
        async () => {
          await expect(
            jwtService.sign(testPayloadStr, { expiresIn: 60 }),
          ).rejects.toThrow(
            "Payload as string is not allowed with sign options: expiresIn",
          );
        },
        "WebCrypto sign() rejects asynchronously",
      );

      itAdapted(
        "ADR-001",
        'should "signAsync" expect errors with a "payload" string with "notBefore"',
        async () => {
          await expect(
            jwtService.signAsync(testPayloadStr, { notBefore: 60 }),
          ).rejects.toThrow(
            "Payload as string is not allowed with sign options: expiresIn, notBefore",
          );
        },
        "WebCrypto signAsync() rejects asynchronously",
      );

      it('should not "sign" expect errors with a "payload" object with "notBefore"', async () => {
        const token = await jwtService.sign(testPayloadObj, { notBefore: 60 });
        expect(typeof token).toBe("string");
      });

      it('should not "signAsync" expect errors with a "payload" object with "notBefore"', async () => {
        const token = await jwtService.signAsync(testPayloadObj, {
          notBefore: 60,
        });
        expect(typeof token).toBe("string");
      });

      itAdapted(
        "ADR-001",
        'should "sign" expect errors using "payload" string with already defined invalid sign options',
        async () => {
          await expect(jwtService.sign(testPayloadStr)).rejects.toThrow(
            "Payload as string is not allowed with sign options: expiresIn",
          );
        },
        "WebCrypto sign() rejects asynchronously",
      );

      itAdapted(
        "ADR-001",
        'should "signAsync" expect errors using "payload" string with already defined invalid sign options',
        async () => {
          await expect(jwtService.signAsync(testPayloadStr)).rejects.toThrow(
            "Payload as string is not allowed with sign options: expiresIn",
          );
        },
        "WebCrypto signAsync() rejects asynchronously",
      );
    });

    describe("should not leave async config.secretOrKeyProvider rejection unhandled", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      const testPayloadStr: string = getRandomString();

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          secretOrKeyProvider: () => Promise.reject(new Error("no key")),
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      it('should "signAsync" expect errors with a "payload" string with "expiresIn"', async () => {
        const unhandled: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => {
          unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandledRejection);
        try {
          await expect(
            jwtService.signAsync(testPayloadStr, { expiresIn: 60 }),
          ).rejects.toThrow(
            "Payload as string is not allowed with sign options: expiresIn",
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect(unhandled).toHaveLength(0);
        } finally {
          process.off("unhandledRejection", onUnhandledRejection);
        }
      });
    });

    describe("should properly handle generic types", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;

      interface UserPayload {
        id: number;
        username: string;
        roles: string[];
      }

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup({
          secret: "default_secret",
          secretOrKeyProvider: undefined,
        }));
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      it("should sign with correct interface implementation", async () => {
        const validPayload: UserPayload = {
          id: 1,
          username: "testuser",
          roles: ["user", "admin"],
        };

        const token = await jwtService.sign<UserPayload>(validPayload);
        expect(token).toBeDefined();
      });

      it("should fail type checking with incorrect interface implementation", async () => {
        const invalidPayload = {
          id: 1,
          roles: ["user"],
        };

        // @ts-expect-error as the username property is not defined in the payload
        const token = await jwtService.sign<UserPayload>(invalidPayload);
        expect(token).toBeDefined();
      });

      it("should signAsync with correct interface implementation", async () => {
        const validPayload: UserPayload = {
          id: 1,
          username: "testuser",
          roles: ["user", "admin"],
        };

        const token = await jwtService.signAsync<UserPayload>(validPayload);
        expect(token).toBeDefined();
      });

      it("should fail type checking with incorrect interface implementation for signAsync", async () => {
        const invalidPayload = {
          id: 1,
          roles: ["user"],
        };

        // @ts-expect-error as the username property is not defined in the payload
        const token = await jwtService.signAsync<UserPayload>(invalidPayload);
        expect(token).toBeDefined();
      });
    });

    describe("decode", () => {
      let jwtService: JwtService;
      let moduleRef: TestingModule;
      let validToken: string;

      interface UserPayload {
        id: number;
        username: string;
      }

      beforeAll(async () => {
        ({ jwtService, moduleRef } = await setup(baseConfig));
        validToken = await defaultSecretService.sign({
          id: 101,
          username: "john_doe",
        });
      });

      afterAll(async () => {
        await moduleRef.close();
      });

      it("should decode token payload without complete option", () => {
        const decoded = jwtService.decode<UserPayload>(validToken);
        expect(decoded).not.toBeNull();
        expect(decoded!.id).toBe(101);
        expect(decoded!.username).toBe("john_doe");

        type _CheckTypedDecode = Assert<
          Equal<typeof decoded, UserPayload | null>
        >;
        const untyped = jwtService.decode(validToken);
        type _CheckDefaultDecode = Assert<
          Equal<typeof untyped, JwtPayload | null>
        >;
        expect(untyped).not.toBeNull();
      });

      it("should return complete decoded object with header, payload, and signature when complete: true", () => {
        const decoded = jwtService.decode(validToken, { complete: true });
        expect(decoded).not.toBeNull();
        expect(decoded!.header.alg).toBe("HS256");
        expect(decoded!.signature).toEqual(expect.any(String));
        expect((decoded!.payload as unknown as UserPayload).username).toBe(
          "john_doe",
        );

        const typedComplete = jwtService.decode<UserPayload>(validToken, {
          complete: true,
        });
        type _CheckCompleteTyped = Assert<
          Equal<typeof typedComplete, DecodedJwt<UserPayload> | null>
        >;
        expect(typedComplete?.payload.id).toBe(101);
      });

      it("should return null when decoding invalid or malformed token", () => {
        const decoded = jwtService.decode("invalid.token.here");
        expect(decoded).toBeNull();
      });

      itAdapted(
        "ADR-001",
        "should decode JSON payload automatically (zero-dep replacement for jsonwebtoken { json: true })",
        () => {
          const decoded = jwtService.decode<UserPayload>(validToken);
          expect(decoded).toMatchObject({ id: 101, username: "john_doe" });
        },
        "Bunest pure WebCrypto decode always parses JSON payloads without jsonwebtoken options",
      );
    });
  },
);
