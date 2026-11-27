import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import {
  AuthenticationError,
  AuthenticationModule,
  AuthenticationStorage,
  COSE_ALG_EDDSA,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  COSE_CRV_ED25519,
  COSE_CRV_P256,
  COSE_KTY_EC2,
  COSE_KTY_OKP,
  COSE_KTY_RSA,
  CborDecodeError,
  CoseKeyError,
  InMemoryPasskeyStore,
  RedisAuthenticationStore,
  SqlAuthenticationStore,
  WebAuthnService,
  createBunSqliteAuthExecutor,
  decodeCbor,
  decodeCborPrefix,
  derToP1363,
  encodeCbor,
  p1363ToDer,
  parseAuthenticatorData,
  parseCosePublicKey,
  type CborKey,
  type CborValue,
  type RedisAuthClientLike,
} from "../../src/auth-next/index";
import {
  WebAuthnService as RootWebAuthnService,
  base64UrlDecode,
  base64UrlEncode,
} from "../../src/index";
import { utf8Encode } from "../../src/utils/crypto.util";

function sha256Raw(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  const d = hasher.digest();
  const out = new Uint8Array(d.byteLength);
  out.set(d);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function buildAuthData(opts: {
  rpId: string;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  cosePublicKeyBytes?: Uint8Array;
  aaguid?: Uint8Array;
}): Uint8Array<ArrayBuffer> {
  const rpIdHash = sha256Raw(utf8Encode(opts.rpId));
  const header = new Uint8Array(37);
  header.set(rpIdHash, 0);
  header[32] = opts.flags;
  new DataView(header.buffer).setUint32(33, opts.signCount, false);

  if (opts.credentialId && opts.cosePublicKeyBytes) {
    const aaguid = opts.aaguid ?? new Uint8Array(16);
    const lenBuf = new Uint8Array(2);
    new DataView(lenBuf.buffer).setUint16(0, opts.credentialId.byteLength, false);
    return concatBytes(
      header,
      aaguid,
      lenBuf,
      opts.credentialId,
      opts.cosePublicKeyBytes,
    );
  }
  return header;
}

async function createEs256Authenticator(rpId: string) {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const x = base64UrlDecode(jwk.x!);
  const y = base64UrlDecode(jwk.y!);
  const coseMap = new Map<CborKey, CborValue>([
    [1, COSE_KTY_EC2],
    [3, COSE_ALG_ES256],
    [-1, COSE_CRV_P256],
    [-2, x],
    [-3, y],
  ]);
  const coseBytes = encodeCbor(coseMap);
  const credentialId = crypto.getRandomValues(new Uint8Array(32));

  const sign = async (data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const rawSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        copy,
      ),
    );
    return p1363ToDer(rawSig, 32);
  };

  return { keyPair, coseBytes, credentialId, rpId, sign };
}

async function createRs256Authenticator(rpId: string) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const n = base64UrlDecode(jwk.n!);
  const e = base64UrlDecode(jwk.e!);
  const coseMap = new Map<CborKey, CborValue>([
    [1, COSE_KTY_RSA],
    [3, COSE_ALG_RS256],
    [-1, n],
    [-2, e],
  ]);
  const coseBytes = encodeCbor(coseMap);
  const credentialId = crypto.getRandomValues(new Uint8Array(24));

  const sign = async (data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      copy,
    );
    return new Uint8Array(sig);
  };

  return { keyPair, coseBytes, credentialId, rpId, sign };
}

async function createEd25519Authenticator(rpId: string) {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as unknown as CryptoKeyPair;
  const rawPub = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const coseMap = new Map<CborKey, CborValue>([
    [1, COSE_KTY_OKP],
    [3, COSE_ALG_EDDSA],
    [-1, COSE_CRV_ED25519],
    [-2, rawPub],
  ]);
  const coseBytes = encodeCbor(coseMap);
  const credentialId = crypto.getRandomValues(new Uint8Array(20));

  const sign = async (data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const sig = await crypto.subtle.sign(
      { name: "Ed25519" },
      keyPair.privateKey,
      copy,
    );
    return new Uint8Array(sig);
  };

  return { keyPair, coseBytes, credentialId, rpId, sign };
}

function makeClientData(obj: Record<string, unknown>): {
  b64: string;
  bytes: Uint8Array<ArrayBuffer>;
} {
  const bytes = utf8Encode(JSON.stringify(obj));
  return { b64: base64UrlEncode(bytes), bytes };
}

describe("WebAuthn / FIDO2 Passkeys — CBOR & COSE Primitives", () => {
  it("encodes and decodes RFC 8949 CBOR values accurately and safely rejects malformed/DoS inputs", () => {
    const sample = new Map<CborKey, CborValue>([
      ["fmt", "none"],
      ["authData", new Uint8Array([1, 2, 3, 4])],
      ["attStmt", new Map<CborKey, CborValue>()],
      [-7, true],
      [-257, false],
      [-8, null],
      [0, [0, 23, 24, 255, 65535, 70000, -1, -65536]],
    ]);
    const encoded = encodeCbor(sample);
    const decoded = decodeCbor(encoded) as Map<CborKey, CborValue>;
    expect(decoded).toBeInstanceOf(Map);
    expect(decoded.get("fmt")).toBe("none");
    expect(decoded.get("authData")).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(decoded.get(-7)).toBe(true);
    expect(decoded.get(-257)).toBe(false);
    expect(decoded.get(-8)).toBeNull();
    expect(decoded.get(0)).toEqual([0, 23, 24, 255, 65535, 70000, -1, -65536]);

    // decodeCborPrefix reads exact item length when trailing data follows
    const withTrailer = concatBytes(encodeCbor(new Map([[1, 2]])), new Uint8Array([0xaa, 0xbb]));
    const prefix = decodeCborPrefix(withTrailer, 0);
    expect(prefix.bytesRead).toBe(withTrailer.byteLength - 2);
    expect(() => decodeCbor(withTrailer)).toThrow(CborDecodeError);

    // Anti-CBOR-bomb: array claiming 0xFFFFFFFF elements in 5 bytes rejects immediately
    const cborBombArray = new Uint8Array([0x9a, 0xff, 0xff, 0xff, 0xff]);
    expect(() => decodeCbor(cborBombArray)).toThrow(CborDecodeError);

    // Anti-CBOR-bomb: map claiming 0xFFFFFFFF pairs rejects immediately
    const cborBombMap = new Uint8Array([0xba, 0xff, 0xff, 0xff, 0xff]);
    expect(() => decodeCbor(cborBombMap)).toThrow(CborDecodeError);

    // Truncated byte string
    expect(() => decodeCbor(new Uint8Array([0x45, 0x01, 0x02]))).toThrow(
      CborDecodeError,
    );

    // Indefinite-length array (0x9f ... 0xff) rejected in strict mode
    expect(() => decodeCbor(new Uint8Array([0x9f, 0x01, 0xff]))).toThrow(
      CborDecodeError,
    );

    // Excessive nesting depth (> maxDepth) rejected
    const deep = new Uint8Array(40);
    deep.fill(0x81, 0, 39); // 39 nested 1-element arrays
    deep[39] = 0x00;
    expect(() => decodeCbor(deep, { maxDepth: 16 })).toThrow(CborDecodeError);

    // Duplicate map keys rejected
    const dupMap = new Uint8Array([0xa2, 0x01, 0x01, 0x01, 0x02]);
    expect(() => decodeCbor(dupMap)).toThrow(CborDecodeError);
  });

  it("validates ASN.1 DER <-> IEEE P1363 conversions and COSE key constraints strictly", () => {
    // High-bit first byte requires 0x00 DER sign pad; leading zeros are stripped
    const p1363 = new Uint8Array(64);
    p1363[0] = 0x80; // r has MSB=1
    p1363[31] = 0x01;
    p1363[32] = 0x00; // s has leading zero
    p1363[33] = 0x7f;
    p1363[63] = 0x05;

    const der = p1363ToDer(p1363, 32);
    expect(derToP1363(der, 32)).toEqual(p1363);

    // Reject trailing bytes in DER
    expect(() => derToP1363(concatBytes(der, new Uint8Array([0x00])))).toThrow(
      CoseKeyError,
    );

    // Reject negative integer (MSB=1 without 0x00 prefix)
    const negDer = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01]);
    expect(() => derToP1363(negDer)).toThrow(CoseKeyError);

    // Reject non-canonical leading zero (0x00 followed by < 0x80)
    const nonCanon = new Uint8Array([
      0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01,
    ]);
    expect(() => derToP1363(nonCanon)).toThrow(CoseKeyError);

    // Reject weak RSA key (< 2048 bits)
    const weakRsa = encodeCbor(
      new Map<CborKey, CborValue>([
        [1, COSE_KTY_RSA],
        [3, COSE_ALG_RS256],
        [-1, new Uint8Array(128).fill(0xff)],
        [-2, new Uint8Array([0x01, 0x00, 0x01])],
      ]),
    );
    expect(() => parseCosePublicKey(weakRsa)).toThrow(CoseKeyError);
  });
});

describe("WebAuthn / FIDO2 Passkeys — End-to-End Registration & Authentication", () => {
  it("completes real ES256 (P-256) registration (none + packed self-attestation) and authentication with signCount progression", async () => {
    expect(RootWebAuthnService).toBe(WebAuthnService);

    let clock = 1_800_000_000_000;
    const service = WebAuthnService.create({
      rpId: "example.com",
      rpName: "Bunest App",
      origin: ["https://example.com", "https://app.example.com"],
      challengeTtl: "5m",
      now: () => clock,
    });

    const auth = await createEs256Authenticator("example.com");

    // 1. Generate registration options
    const regOpts = await service.generateRegistrationOptions({
      userId: "user-es256",
      userName: "alice@example.com",
      userDisplayName: "Alice",
    });
    expect(regOpts.rp).toEqual({ id: "example.com", name: "Bunest App" });
    expect(regOpts.challenge.length).toBeGreaterThanOrEqual(40);
    expect(regOpts.excludeCredentials).toEqual([]);

    // 2. Build real packed self-attestation object
    const clientDataReg = makeClientData({
      type: "webauthn.create",
      challenge: regOpts.challenge,
      origin: "https://example.com",
      crossOrigin: false,
    });
    const regAuthData = buildAuthData({
      rpId: "example.com",
      flags: 0x01 | 0x04 | 0x08 | 0x10 | 0x40, // UP | UV | BE | BS | AT
      signCount: 1,
      credentialId: auth.credentialId,
      cosePublicKeyBytes: auth.coseBytes,
    });
    const selfAttSig = await auth.sign(
      concatBytes(regAuthData, sha256Raw(clientDataReg.bytes)),
    );
    const attestationObject = encodeCbor(
      new Map<CborKey, CborValue>([
        ["fmt", "packed"],
        ["authData", regAuthData],
        [
          "attStmt",
          new Map<CborKey, CborValue>([
            ["alg", COSE_ALG_ES256],
            ["sig", selfAttSig],
          ]),
        ],
      ]),
    );

    const regResult = await service.verifyRegistration({
      userId: "user-es256",
      name: "MacBook Touch ID",
      id: base64UrlEncode(auth.credentialId),
      response: {
        clientDataJSON: clientDataReg.b64,
        attestationObject: base64UrlEncode(attestationObject),
        transports: ["internal", "hybrid"],
      },
    });

    expect(regResult.verified).toBe(true);
    expect(regResult.fmt).toBe("packed");
    expect(regResult.userPresent).toBe(true);
    expect(regResult.userVerified).toBe(true);
    expect(regResult.credential.algorithm).toBe(COSE_ALG_ES256);
    expect(regResult.credential.counter).toBe(1);
    expect(regResult.credential.deviceType).toBe("multiDevice");
    expect(regResult.credential.backedUp).toBe(true);
    expect(regResult.credential.name).toBe("MacBook Touch ID");

    // Subsequent registration options auto-exclude existing passkey
    const regOpts2 = await service.generateRegistrationOptions({
      userId: "user-es256",
      userName: "alice@example.com",
    });
    expect(regOpts2.excludeCredentials).toHaveLength(1);
    expect(regOpts2.excludeCredentials[0]?.id).toBe(regResult.credential.id);

    // 3. Authenticate with real ECDSA P-256 DER signature and counter 1 -> 2
    const authOpts = await service.generateAuthenticationOptions({
      userId: "user-es256",
    });
    expect(authOpts.allowCredentials).toHaveLength(1);
    expect(authOpts.allowCredentials[0]?.id).toBe(regResult.credential.id);

    const clientDataAuth = makeClientData({
      type: "webauthn.get",
      challenge: authOpts.challenge,
      origin: "https://app.example.com",
    });
    const assertAuthData = buildAuthData({
      rpId: "example.com",
      flags: 0x01 | 0x04, // UP | UV
      signCount: 2,
    });
    const assertionSig = await auth.sign(
      concatBytes(assertAuthData, sha256Raw(clientDataAuth.bytes)),
    );

    clock += 5_000;
    const authResult = await service.verifyAuthentication({
      userId: "user-es256",
      id: regResult.credential.id,
      response: {
        clientDataJSON: clientDataAuth.b64,
        authenticatorData: base64UrlEncode(assertAuthData),
        signature: base64UrlEncode(assertionSig),
        userHandle: base64UrlEncode(utf8Encode("user-es256")),
      },
    });

    expect(authResult.verified).toBe(true);
    expect(authResult.userId).toBe("user-es256");
    expect(authResult.newCounter).toBe(2);
    expect(authResult.credential.counter).toBe(2);
    expect(authResult.credential.lastUsedAt?.getTime()).toBe(clock);

    // 4. Replaying same authentication challenge fails (single-use)
    await expect(
      service.verifyAuthentication({
        userId: "user-es256",
        id: regResult.credential.id,
        response: {
          clientDataJSON: clientDataAuth.b64,
          authenticatorData: base64UrlEncode(assertAuthData),
          signature: base64UrlEncode(assertionSig),
        },
      }),
    ).rejects.toMatchObject({ code: "webauthn_invalid_challenge" });

    // 5. Monotonic signCount replay attacks (same=2, lower=1, zero=0) MUST be rejected!
    for (const badCount of [2, 1, 0]) {
      const freshOpts = await service.generateAuthenticationOptions({
        userId: "user-es256",
      });
      const cd = makeClientData({
        type: "webauthn.get",
        challenge: freshOpts.challenge,
        origin: "https://example.com",
      });
      const badAuthData = buildAuthData({
        rpId: "example.com",
        flags: 0x01 | 0x04,
        signCount: badCount,
      });
      const validSigOverBadCount = await auth.sign(
        concatBytes(badAuthData, sha256Raw(cd.bytes)),
      );

      await expect(
        service.verifyAuthentication({
          id: regResult.credential.id,
          response: {
            clientDataJSON: cd.b64,
            authenticatorData: base64UrlEncode(badAuthData),
            signature: base64UrlEncode(validSigOverBadCount),
          },
        }),
      ).rejects.toMatchObject({ code: "webauthn_replay_detected" });
    }
  });

  it("completes real RS256 (2048-bit RSA) and Ed25519 (EdDSA) registration and authentication", async () => {
    const service = WebAuthnService.create({
      rpId: "localhost",
      rpName: "Local RP",
      origin: "http://localhost:3000",
    });

    for (const [label, factory, expectedAlg] of [
      ["RS256", createRs256Authenticator, COSE_ALG_RS256],
      ["Ed25519", createEd25519Authenticator, COSE_ALG_EDDSA],
    ] as const) {
      const auth = await factory("localhost");
      const userId = `user-${label}`;
      const regOpts = await service.generateRegistrationOptions({
        userId,
        userName: `${label}@localhost`,
      });
      const cdReg = makeClientData({
        type: "webauthn.create",
        challenge: regOpts.challenge,
        origin: "http://localhost:3000",
      });
      // Synced passkey with signCount = 0 -> 0 allowed per WebAuthn §7.2
      const regAuthData = buildAuthData({
        rpId: "localhost",
        flags: 0x01 | 0x40, // UP | AT
        signCount: 0,
        credentialId: auth.credentialId,
        cosePublicKeyBytes: auth.coseBytes,
      });
      const attObj = encodeCbor(
        new Map<CborKey, CborValue>([
          ["fmt", "none"],
          ["authData", regAuthData],
          ["attStmt", new Map()],
        ]),
      );

      const reg = await service.verifyRegistration({
        userId,
        response: {
          id: base64UrlEncode(auth.credentialId),
          clientDataJSON: cdReg.b64,
          attestationObject: base64UrlEncode(attObj),
        },
      });
      expect(reg.credential.algorithm).toBe(expectedAlg);

      // Discoverable (usernameless) authentication
      const authOpts = await service.generateAuthenticationOptions();
      expect(authOpts.allowCredentials).toEqual([]);
      const cdAuth = makeClientData({
        type: "webauthn.get",
        challenge: authOpts.challenge,
        origin: "http://localhost:3000",
      });
      const assertAuthData = buildAuthData({
        rpId: "localhost",
        flags: 0x01,
        signCount: 0,
      });
      const sig = await auth.sign(
        concatBytes(assertAuthData, sha256Raw(cdAuth.bytes)),
      );
      const verified = await service.verifyAuthentication({
        id: reg.credential.id,
        response: {
          clientDataJSON: cdAuth.b64,
          authenticatorData: base64UrlEncode(assertAuthData),
          signature: base64UrlEncode(sig),
        },
      });
      expect(verified.verified).toBe(true);
      expect(verified.userId).toBe(userId);
      expect(verified.newCounter).toBe(0);
    }
  });

  it("rejects tampered signature, wrong origin, wrong rpIdHash, missing UP/UV, expired challenge, and cross-user challenge", async () => {
    let clock = 1_900_000_000_000;
    const service = WebAuthnService.create({
      rpId: "example.com",
      rpName: "Secure RP",
      origin: "https://example.com",
      challengeTtl: "1m",
      userVerification: "required",
      now: () => clock,
    });

    const auth = await createEs256Authenticator("example.com");

    // Register valid credential first
    const regOpts = await service.generateRegistrationOptions({
      userId: "alice",
      userName: "alice@example.com",
    });
    const cdReg = makeClientData({
      type: "webauthn.create",
      challenge: regOpts.challenge,
      origin: "https://example.com",
    });
    const regAuthData = buildAuthData({
      rpId: "example.com",
      flags: 0x01 | 0x04 | 0x40,
      signCount: 10,
      credentialId: auth.credentialId,
      cosePublicKeyBytes: auth.coseBytes,
    });
    const regAtt = encodeCbor(
      new Map<CborKey, CborValue>([
        ["fmt", "none"],
        ["authData", regAuthData],
        ["attStmt", new Map()],
      ]),
    );
    const { credential } = await service.verifyRegistration({
      userId: "alice",
      response: {
        clientDataJSON: cdReg.b64,
        attestationObject: base64UrlEncode(regAtt),
      },
    });

    // Helper to prepare valid auth assertion with customizable mutations
    const attemptAuth = async (mutate?: {
      origin?: string;
      crossOrigin?: boolean;
      rpId?: string;
      flags?: number;
      tamperSig?: boolean;
      advanceClockMs?: number;
      userId?: string;
    }) => {
      const opts = await service.generateAuthenticationOptions({
        userId: "alice",
      });
      if (mutate?.advanceClockMs) {
        clock += mutate.advanceClockMs;
      }
      const cd = makeClientData({
        type: "webauthn.get",
        challenge: opts.challenge,
        origin: mutate?.origin ?? "https://example.com",
        ...(mutate?.crossOrigin !== undefined
          ? { crossOrigin: mutate.crossOrigin }
          : {}),
      });
      const ad = buildAuthData({
        rpId: mutate?.rpId ?? "example.com",
        flags: mutate?.flags ?? (0x01 | 0x04),
        signCount: 11,
      });
      const sig = await auth.sign(concatBytes(ad, sha256Raw(cd.bytes)));
      if (mutate?.tamperSig) {
        sig[sig.byteLength - 1] = sig[sig.byteLength - 1]! ^ 0xff;
      }
      return service.verifyAuthentication({
        userId: mutate?.userId ?? "alice",
        id: credential.id,
        response: {
          clientDataJSON: cd.b64,
          authenticatorData: base64UrlEncode(ad),
          signature: base64UrlEncode(sig),
        },
      });
    };

    // 1. Tampered signature
    await expect(attemptAuth({ tamperSig: true })).rejects.toMatchObject({
      code: "webauthn_invalid_signature",
    });

    // 2. Wrong origin (including prefix spoof!)
    await expect(
      attemptAuth({ origin: "https://example.com.evil.com" }),
    ).rejects.toMatchObject({ code: "webauthn_invalid_origin" });

    // 3. crossOrigin: true
    await expect(attemptAuth({ crossOrigin: true })).rejects.toMatchObject({
      code: "webauthn_cross_origin",
    });

    // 4. Wrong rpIdHash
    await expect(attemptAuth({ rpId: "evil.com" })).rejects.toMatchObject({
      code: "webauthn_invalid_rpid",
    });

    // 5. Missing UP flag
    await expect(attemptAuth({ flags: 0x04 })).rejects.toMatchObject({
      code: "webauthn_user_not_present",
    });

    // 6. Missing UV flag when required
    await expect(attemptAuth({ flags: 0x01 })).rejects.toMatchObject({
      code: "webauthn_user_verification_required",
    });

    // 7. Expired challenge
    await expect(attemptAuth({ advanceClockMs: 65_000 })).rejects.toMatchObject({
      code: "webauthn_challenge_expired",
    });

    // 8. Wrong userId claiming alice's credential
    await expect(attemptAuth({ userId: "bob" })).rejects.toMatchObject({
      code: "webauthn_credential_user_mismatch",
    });

    // 9. Cross-user registration challenge hijacking
    const bobOpts = await service.generateRegistrationOptions({
      userId: "bob",
      userName: "bob@example.com",
    });
    const cdHijack = makeClientData({
      type: "webauthn.create",
      challenge: bobOpts.challenge,
      origin: "https://example.com",
    });
    await expect(
      service.verifyRegistration({
        userId: "mallory",
        response: {
          clientDataJSON: cdHijack.b64,
          attestationObject: base64UrlEncode(regAtt),
        },
      }),
    ).rejects.toMatchObject({ code: "webauthn_challenge_user_mismatch" });

    // 10. All errors are instances of AuthenticationError
    expect(
      await attemptAuth({ tamperSig: true }).catch((e) => e),
    ).toBeInstanceOf(AuthenticationError);
  });

  it("integrates with AuthenticationModule, SqlAuthenticationStore (bun:sqlite), and RedisAuthenticationStore", async () => {
    // 1. AuthenticationModule DI registration
    const mod = await Test.createTestingModule({
      imports: [
        AuthenticationModule.forRoot({
          webauthn: {
            rpId: "example.com",
            rpName: "DI App",
            origin: "https://example.com",
          },
        }),
      ],
    }).compile();

    try {
      const diService = mod.get(WebAuthnService);
      expect(diService).toBeInstanceOf(WebAuthnService);
      const opts = await diService.generateRegistrationOptions({
        userId: "di-user",
        userName: "di@example.com",
      });
      expect(opts.rp.id).toBe("example.com");
    } finally {
      await mod.close();
    }

    // 2. End-to-end WebAuthn on SqlAuthenticationStore (real bun:sqlite)
    const db = new Database(":memory:");
    try {
      const sqlStore = new SqlAuthenticationStore(
        createBunSqliteAuthExecutor(db),
        { dialect: "sqlite" },
      );
      await sqlStore.migrate();

      const sqlStorage = new AuthenticationStorage();
      sqlStore.registerInto(sqlStorage);
      const sqlWebAuthn = new WebAuthnService(sqlStorage, {
        webauthn: {
          rpId: "sql.example.com",
          rpName: "SQL RP",
          origin: "https://sql.example.com",
        },
      });

      const auth = await createEs256Authenticator("sql.example.com");
      const regOpts = await sqlWebAuthn.generateRegistrationOptions({
        userId: "u-sql",
        userName: "sql@example.com",
      });
      const cdReg = makeClientData({
        type: "webauthn.create",
        challenge: regOpts.challenge,
        origin: "https://sql.example.com",
      });
      const regAd = buildAuthData({
        rpId: "sql.example.com",
        flags: 0x01 | 0x04 | 0x40,
        signCount: 1,
        credentialId: auth.credentialId,
        cosePublicKeyBytes: auth.coseBytes,
      });
      const regRes = await sqlWebAuthn.verifyRegistration({
        userId: "u-sql",
        response: {
          clientDataJSON: cdReg.b64,
          attestationObject: base64UrlEncode(
            encodeCbor(
              new Map<CborKey, CborValue>([
                ["fmt", "none"],
                ["authData", regAd],
                ["attStmt", new Map()],
              ]),
            ),
          ),
        },
      });
      expect((await sqlWebAuthn.listPasskeys("u-sql")).length).toBe(1);

      // Authenticate + counter update persisted in SQL
      const authOpts = await sqlWebAuthn.generateAuthenticationOptions({
        userId: "u-sql",
      });
      const cdAuth = makeClientData({
        type: "webauthn.get",
        challenge: authOpts.challenge,
        origin: "https://sql.example.com",
      });
      const authAd = buildAuthData({
        rpId: "sql.example.com",
        flags: 0x01 | 0x04,
        signCount: 5,
      });
      const sig = await auth.sign(concatBytes(authAd, sha256Raw(cdAuth.bytes)));
      const authRes = await sqlWebAuthn.verifyAuthentication({
        id: regRes.credential.id,
        response: {
          clientDataJSON: cdAuth.b64,
          authenticatorData: base64UrlEncode(authAd),
          signature: base64UrlEncode(sig),
        },
      });
      expect(authRes.newCounter).toBe(5);
      expect((await sqlStore.getPasskey(regRes.credential.id))?.counter).toBe(5);

      // Replay with counter 5 fails against SQL atomic counter check
      expect(await sqlStore.updatePasskeyCounter(regRes.credential.id, 5)).toBe(
        false,
      );
      expect(await sqlWebAuthn.removePasskey(regRes.credential.id)).toBe(true);
      expect(await sqlWebAuthn.listPasskeys("u-sql")).toEqual([]);
    } finally {
      db.close();
    }

    // 3. End-to-end WebAuthn on RedisAuthenticationStore (exercising BOTH Lua send("EVAL") & empty transports `[]` -> `{}` round-trip)
    const strings = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    let evalCalls = 0;

    // Simulate Redis Lua cjson encoding empty JSON arrays `[]` as `{}`
    const simulateLuaCjsonRoundTrip = (obj: Record<string, unknown>) => {
      const cloned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        cloned[k] = Array.isArray(v) && v.length === 0 ? {} : v;
      }
      return JSON.stringify(cloned);
    };

    const mockRedis: RedisAuthClientLike = {
      async get(k) {
        return strings.get(k) ?? null;
      },
      async set(k, v) {
        strings.set(k, v);
        return "OK";
      },
      async del(...keys) {
        let n = 0;
        for (const k of keys) {
          if (strings.delete(k) || sets.delete(k)) n++;
        }
        return n;
      },
      async sadd(k, ...members) {
        let s = sets.get(k);
        if (!s) {
          s = new Set();
          sets.set(k, s);
        }
        let n = 0;
        for (const m of members) {
          if (!s.has(m)) {
            s.add(m);
            n++;
          }
        }
        return n;
      },
      async srem(k, ...members) {
        const s = sets.get(k);
        if (!s) return 0;
        let n = 0;
        for (const m of members) {
          if (s.delete(m)) n++;
        }
        return n;
      },
      async smembers(k) {
        return [...(sets.get(k) ?? [])];
      },
      async expire() {
        return 1;
      },
      async exists(k) {
        return strings.has(k) || sets.has(k) ? 1 : 0;
      },
      async send(command: string, args: string[]) {
        if (command !== "EVAL") {
          throw new Error(`Unexpected command ${command}`);
        }
        evalCalls++;
        const script = args[0]!;
        const key = args[2]!;
        const arg1 = args[3]!;
        const arg2 = args[4];

        if (script.includes("nextCounter")) {
          const raw = strings.get(key);
          if (!raw) return 0;
          const rec = JSON.parse(raw) as Record<string, unknown>;
          const nextCounter = Number(arg1);
          const prevCounter = Number(rec.counter ?? 0);
          if (nextCounter === 0) {
            if (prevCounter !== 0) return 0;
          } else if (nextCounter <= prevCounter) {
            return 0;
          }
          rec.counter = nextCounter;
          if (arg2 && arg2 !== "") {
            rec.lastUsedAt = Number(arg2);
          }
          strings.set(key, simulateLuaCjsonRoundTrip(rec));
          return 1;
        }

        if (script.includes("rec.type ~= ARGV[1]")) {
          const raw = strings.get(key);
          if (!raw) return null;
          const rec = JSON.parse(raw) as { type?: string };
          if (rec.type !== arg1) return null;
          strings.delete(key);
          return raw;
        }

        throw new Error("Unknown Lua script");
      },
    };

    const redisStore = new RedisAuthenticationStore(mockRedis, {
      keyPrefix: "test:wa:",
    });
    const redisWebAuthn = WebAuthnService.create(
      {
        rpId: "redis.example.com",
        rpName: "Redis RP",
        origin: "https://redis.example.com",
      },
      redisStore,
    );
    const rAuth = await createEs256Authenticator("redis.example.com");
    const rRegOpts = await redisWebAuthn.generateRegistrationOptions({
      userId: "u-redis",
      userName: "redis@example.com",
    });

    // Wrong challenge type via Lua EVAL does NOT consume registration challenge
    expect(
      await redisStore.consumePasskeyChallenge(
        rRegOpts.challenge,
        "authentication",
      ),
    ).toBeUndefined();

    const rCdReg = makeClientData({
      type: "webauthn.create",
      challenge: rRegOpts.challenge,
      origin: "https://redis.example.com",
    });
    const rRegAd = buildAuthData({
      rpId: "redis.example.com",
      flags: 0x01 | 0x04 | 0x40,
      signCount: 0,
      credentialId: rAuth.credentialId,
      cosePublicKeyBytes: rAuth.coseBytes,
    });
    // Explicitly test empty transports: [] through Lua cjson round-trip
    const rReg = await redisWebAuthn.verifyRegistration({
      userId: "u-redis",
      response: {
        clientDataJSON: rCdReg.b64,
        attestationObject: base64UrlEncode(
          encodeCbor(
            new Map<CborKey, CborValue>([
              ["fmt", "none"],
              ["authData", rRegAd],
              ["attStmt", new Map()],
            ]),
          ),
        ),
        transports: [],
      },
    });
    expect((await redisStore.listUserPasskeys("u-redis")).length).toBe(1);
    expect(await redisStore.updatePasskeyCounter(rReg.credential.id, 0)).toBe(true);
    expect(await redisStore.updatePasskeyCounter(rReg.credential.id, 3)).toBe(true);
    expect(await redisStore.updatePasskeyCounter(rReg.credential.id, 3)).toBe(false);
    expect(await redisStore.updatePasskeyCounter(rReg.credential.id, 0)).toBe(false);
    // Reading back after Lua cjson converted `[]` -> `{}` must NOT throw and must restore `[]`
    const reloaded = await redisStore.getPasskey(rReg.credential.id);
    expect(reloaded?.counter).toBe(3);
    expect(reloaded?.transports).toEqual([]);
    expect((await redisStore.listUserPasskeys("u-redis"))[0]?.transports).toEqual([]);
    expect(evalCalls).toBeGreaterThanOrEqual(6);
    await redisWebAuthn.removeUserPasskeys("u-redis");
    expect(await redisStore.listUserPasskeys("u-redis")).toEqual([]);

    // Confirm parseAuthenticatorData rejects truncated / trailing bytes
    expect(() => parseAuthenticatorData(new Uint8Array(10))).toThrow(
      AuthenticationError,
    );
    expect(() =>
      parseAuthenticatorData(
        concatBytes(
          buildAuthData({ rpId: "example.com", flags: 0x01, signCount: 0 }),
          new Uint8Array([0x01]),
        ),
      ),
    ).toThrow(AuthenticationError);
    expect(new InMemoryPasskeyStore()).toBeInstanceOf(InMemoryPasskeyStore);
  });
});
