import { describe, expect, it } from "bun:test";
import {
  AuthenticationEvents,
  AuthenticationStorage,
  InMemorySessionStore,
  MfaAlreadyEnrolledError,
  MfaService,
  PasswordHasher,
  SessionService,
  type AuthenticationEvent,
} from "../../src/auth-next/index";
import { base32Decode, hotp } from "../../src/auth-next/mfa/otp.util";

const T0 = 1_700_000_000_000;

describe("PasswordHasher, SessionService & MfaService", () => {
  it("PasswordHasher hashes, verifies, normalizes NFKC, detects rehash, and rejects invalid inputs", async () => {
    const hasher = new PasswordHasher({ logN: 10 });
    const hash = await hasher.hash("ﬁle-secret-123");
    expect(hash.startsWith("$scrypt$ln=10,r=8,p=1$")).toBe(true);
    // NFKC equivalence: U+FB01 ('ﬁ') === 'fi'
    expect(await hasher.verify("file-secret-123", hash)).toBe(true);
    expect(await hasher.verify("wrong", hash)).toBe(false);
    expect(await hasher.verify("any", undefined)).toBe(false);
    expect(await hasher.verify("any", "!")).toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);

    // Higher cost detects rehash and still verifies old hash with work top-up
    const stronger = new PasswordHasher({ logN: 11 });
    expect(stronger.needsRehash(hash)).toBe(true);
    expect(await stronger.verify("file-secret-123", hash)).toBe(true);

    // Default PasswordHasher uses native Bun.password (argon2id) and seamlessly verifies/flags legacy $scrypt$ hashes
    const nativeArgon = new PasswordHasher({ memoryCost: 4096, timeCost: 1 });
    const argonHash = await nativeArgon.hash("ﬁle-secret-123");
    expect(argonHash.startsWith("$argon2id$")).toBe(true);
    expect(await nativeArgon.verify("file-secret-123", argonHash)).toBe(true);
    expect(await nativeArgon.verify("wrong", argonHash)).toBe(false);
    expect(nativeArgon.needsRehash(argonHash)).toBe(false);
    expect(await nativeArgon.verify("file-secret-123", hash)).toBe(true);
    expect(nativeArgon.needsRehash(hash)).toBe(true);

    // Invalid inputs refused
    await expect(hasher.hash("")).rejects.toThrow(RangeError);
    await expect(hasher.hash("x".repeat(4097))).rejects.toThrow(RangeError);
    await expect(hasher.hash(123 as any)).rejects.toThrow(TypeError);
    expect(await hasher.verify("", hash)).toBe(false);
    expect(await hasher.verify("x".repeat(4097), hash)).toBe(false);
  });

  it("SessionService handles lifecycle, sliding idle, absolute expiry, fixation defense, touch resilience, and CSRF", async () => {
    let clock = T0;
    const baseStore = new InMemorySessionStore();
    let failTouch = false;
    const flakyStore = {
      getSession: (id: string) => baseStore.getSession(id),
      createSession: (r: any) => baseStore.createSession(r),
      touchSession: async (id: string, at: Date) => {
        if (failTouch) throw new Error("replica read-only");
        return baseStore.touchSession(id, at);
      },
      deleteSession: (id: string) => baseStore.deleteSession(id),
      listUserSessions: (uid: string) => baseStore.listUserSessions(uid),
      deleteUserSessions: (uid: string) => baseStore.deleteUserSessions(uid),
    };
    const storage = new AuthenticationStorage();
    storage.registerSource({ sessions: flakyStore });
    const events = new AuthenticationEvents();
    const seen: AuthenticationEvent[] = [];
    events.events$.subscribe((e) => seen.push(e));

    const sessions = new SessionService(
      storage,
      {
        session: {
          absoluteTtl: "1h",
          idleTtl: "10m",
          touchInterval: "1m",
          trustedOrigins: ["https://spa.example"],
          now: () => clock,
        },
        mfa: { encryption: false, pendingTtl: "5m", now: () => clock },
      },
      events,
    );

    // Create pending MFA session -> expires in pendingTtl (5m)
    const pending = await sessions.create("u1", { mfa: "pending" });
    expect(pending.cookie).toContain("__Host-sid=");
    expect(pending.cookie).toContain("HttpOnly");
    expect(pending.cookie).toContain("Secure");
    expect(pending.session.expiresAt.getTime()).toBe(T0 + 5 * 60_000);

    // Rotate pending -> verified restores full absoluteTtl from creation
    clock += 60_000;
    const verified = await sessions.rotate(pending.session, {
      mfa: "verified",
    });
    expect(verified).not.toBeNull();
    expect(verified!.session.expiresAt.getTime()).toBe(T0 + 60 * 60_000);
    // Old token invalidated
    expect(await sessions.validate(pending.token)).toBeNull();

    // Touch failure does not reject valid session, emits session-touch-failed
    clock += 2 * 60_000;
    failTouch = true;
    const alive = await sessions.validate(verified!.token);
    expect(alive?.userId).toBe("u1");
    expect(seen.some((e) => e.type === "session-touch-failed")).toBe(true);
    failTouch = false;

    // Session fixation defense: create with replacing deletes old session
    const second = await sessions.create("u1", { replacing: verified!.token });
    expect(await sessions.validate(verified!.token)).toBeNull();
    expect((await sessions.validate(second.token))?.userId).toBe("u1");

    // Cross-origin write protection
    expect(
      sessions.isCrossOriginWrite({
        method: "POST",
        headers: {
          "sec-fetch-site": "cross-site",
          origin: "https://evil.test",
        },
      }),
    ).toBe(true);
    expect(
      sessions.isCrossOriginWrite({
        method: "POST",
        headers: {
          "sec-fetch-site": "cross-site",
          origin: "https://spa.example",
        },
      }),
    ).toBe(false);
    expect(
      sessions.isCrossOriginWrite({
        method: "GET",
        headers: {
          "sec-fetch-site": "cross-site",
          origin: "https://evil.test",
        },
      }),
    ).toBe(false);
    // WebSocket upgrade counts as state-changing even on GET
    expect(
      sessions.isCrossOriginWrite({
        method: "GET",
        headers: {
          upgrade: "websocket",
          origin: "https://evil.test",
          host: "app.example",
        },
      }),
    ).toBe(true);

    // Revoke enforces ownership
    expect(await sessions.revoke(second.session.id, { userId: "other" })).toBe(
      false,
    );
    expect(await sessions.revoke(second.session.id, { userId: "u1" })).toBe(
      true,
    );
    expect(await sessions.list("u1")).toEqual([]);
  });

  it("MfaService encrypts secrets with AES-256-GCM, rotates keys, binds AAD to userId, prevents replay, and handles recovery codes", async () => {
    let clock = T0;
    const storage = new AuthenticationStorage();
    const events = new AuthenticationEvents();
    const oldKey = "old-encryption-key-at-least-32-bytes!";
    const newKey = "new-encryption-key-at-least-32-bytes!";

    const mfaOld = new MfaService(
      storage,
      {
        mfa: {
          encryption: { keys: [oldKey] },
          issuer: "Bunest App",
          now: () => clock,
        },
      },
      events,
    );
    const { secret, uri } = await mfaOld.enroll("u1", "alice@example.com");
    expect(uri).toContain("otpauth://totp/Bunest%20App:alice%40example.com");
    expect(uri).toContain(`secret=${secret}`);

    // Stored secret is encrypted, NOT plaintext
    const stored = await storage.mfa.getTotp("u1");
    expect(stored?.secret).not.toBe(secret);
    expect(stored?.secret.startsWith("v1.")).toBe(true);

    const codeAt = (sec: string, offset = 0) =>
      hotp(base32Decode(sec), Math.floor(clock / 30_000) + offset);
    expect(await mfaOld.confirm("u1", codeAt(secret))).toBe(true);
    expect(await mfaOld.isEnrolled("u1")).toBe(true);

    // Re-enrolling without replace throws MfaAlreadyEnrolledError (409)
    await expect(
      mfaOld.enroll("u1", "alice@example.com"),
    ).rejects.toBeInstanceOf(MfaAlreadyEnrolledError);
    try {
      await mfaOld.enroll("u1", "alice@example.com");
    } catch (err) {
      expect((err as MfaAlreadyEnrolledError).status).toBe(409);
    }

    // Copied ciphertext to another user fails closed (AAD binds to totp.<userId>)
    const confirmedRow = (await storage.mfa.getTotp("u1"))!;
    await storage.mfa.saveTotp("u2", { ...confirmedRow });
    clock += 30_000;
    expect(await mfaOld.verifyTotp("u2", codeAt(secret))).toBe(false);

    // Key rotation: reencrypt updates ciphertext to new key
    const mfaRotated = new MfaService(
      storage,
      {
        mfa: {
          encryption: { keys: [newKey, oldKey] },
          now: () => clock,
        },
      },
      events,
    );
    expect(await mfaRotated.reencrypt("u1")).toBe(true);
    expect(await mfaRotated.reencrypt("u1")).toBe(false);
    expect(await mfaRotated.verifyTotp("u1", codeAt(secret))).toBe(true);
    // Replay of same step rejected
    expect(await mfaRotated.verifyTotp("u1", codeAt(secret))).toBe(false);

    // Staged replacement keeps old authenticator working until new is confirmed
    const replacement = await mfaRotated.enroll("u1", "alice@example.com", {
      replace: true,
    });
    clock += 30_000;
    expect(await mfaRotated.verifyTotp("u1", codeAt(secret))).toBe(true);
    clock += 30_000;
    expect(await mfaRotated.confirm("u1", codeAt(replacement.secret))).toBe(
      true,
    );
    clock += 30_000;
    expect(await mfaRotated.verifyTotp("u1", codeAt(secret))).toBe(false);
    expect(await mfaRotated.verifyTotp("u1", codeAt(replacement.secret))).toBe(
      true,
    );

    // Recovery codes
    const codes = await mfaRotated.generateRecoveryCodes("u1");
    expect(codes.length).toBe(10);
    expect(await mfaRotated.remainingRecoveryCodes("u1")).toBe(10);
    expect(
      await mfaRotated.verifyRecoveryCode(
        "u1",
        codes[0]!.toLowerCase().replace("-", " "),
      ),
    ).toBe(true);
    expect(await mfaRotated.remainingRecoveryCodes("u1")).toBe(9);
    expect(await mfaRotated.verifyRecoveryCode("u1", codes[0]!)).toBe(false);

    // Disable removes authenticator & recovery codes
    await mfaRotated.disable("u1");
    expect(await mfaRotated.isEnrolled("u1")).toBe(false);
    expect(await mfaRotated.remainingRecoveryCodes("u1")).toBe(0);
  });
});
