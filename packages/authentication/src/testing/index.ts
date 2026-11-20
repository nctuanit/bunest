/**
 * `@bunest/authentication/testing`: the contract every store must honour, as test cases that run
 * under any test runner. Each case throws (a `node:assert` error) on failure.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EmailVerificationHandler } from "../account/email-verification.handler";
import { EmailVerificationService } from "../account/email-verification.service";
import { PasswordResetHandler } from "../account/password-reset.handler";
import { PasswordResetService } from "../account/password-reset.service";
import { AuthenticationEvents } from "../events/authentication-events.service";
import type {
  AuthenticationStorageContract,
  AuthenticationStorageSources,
} from "../interfaces/authentication-storage.interface";
import type { EmailTokenRecord } from "../interfaces/email-token-store.interface";
import type { MagicLinkRecord } from "../interfaces/magic-link-store.interface";
import type { OidcTransaction } from "../interfaces/oidc.interface";
import type { RefreshTokenRecord } from "../interfaces/refresh-token-store.interface";
import type { SessionRecord } from "../interfaces/session-store.interface";
import { TokenService } from "../jwt/token.service";
import { MfaService } from "../mfa/mfa.service";
import { base32Decode, hotp } from "../mfa/otp.util";
import {
  AuthenticationRegistry,
  LOCK_REGISTRY,
} from "../services/authentication-registry.service";
import { PasswordHasher } from "../services/password-hasher.service";
import { SessionService } from "../session/session.service";
import { SignInService } from "../session/sign-in.service";
import {
  AuthenticationStorage,
  LOCK_STORAGE,
} from "../storage/authentication.storage";

export interface AuthenticationStoreContractOptions {
  /**
   * The contracts to check, which `create()` must return. Default: all six.
   */
  contracts?: AuthenticationStorageContract[];
  /**
   * Adds the concurrency cases: parallel calls on one token, one code, one link.
   */
  concurrent?: boolean;
  /**
   * The most pending magic links, OIDC logins and email tokens your store keeps (per kind).
   */
  maxPending?: number;
}

/** One case: `run()` resolves, or rejects with an assertion error. */
export interface AuthenticationStoreContractCase {
  /** `<contract>: <what it checks>`. */
  name: string;
  contract: AuthenticationStorageContract;
  run(): Promise<void>;
}

/** Stores on fresh state: `create()` is called once per case. */
export type AuthenticationStoreFactory = () =>
  | AuthenticationStorageSources
  | Promise<AuthenticationStorageSources>;

const ALL: readonly AuthenticationStorageContract[] = [
  "sessions",
  "refreshTokens",
  "mfa",
  "magicLinks",
  "oidcStates",
  "emailTokens",
];
const SECRET = "contract-suite-secret-of-at-least-32-bytes!";
const T0 = 1_700_000_000_000;
const at = (ms: number): Date => new Date(T0 + ms);

/**
 * The cases every implementation of the given contracts must pass.
 */
export function authenticationStoreContract(
  create: AuthenticationStoreFactory,
  options: AuthenticationStoreContractOptions = {},
): AuthenticationStoreContractCase[] {
  const contracts = options.contracts ?? [...ALL];
  for (const contract of contracts) {
    if (!ALL.includes(contract)) {
      throw new TypeError(
        `authenticationStoreContract(): unknown contract \`${String(contract)}\``,
      );
    }
  }
  const cases: AuthenticationStoreContractCase[] = [];
  const add = (
    contract: AuthenticationStorageContract,
    name: string,
    run: (sources: AuthenticationStorageSources) => Promise<void>,
    when = true,
  ) => {
    if (!when || !contracts.includes(contract)) {
      return;
    }
    cases.push({
      contract,
      name: `${contract}: ${name}`,
      run: async () => run(await fresh(create, contract)),
    });
  };
  const concurrent = options.concurrent === true;
  const maxPending = options.maxPending;
  if (
    maxPending !== undefined &&
    !(Number.isSafeInteger(maxPending) && maxPending > 0)
  ) {
    throw new TypeError(
      `authenticationStoreContract(): maxPending must be a positive integer (got ${String(maxPending)})`,
    );
  }

  // ---------------------------------------------------------------- sessions
  add(
    "sessions",
    "round-trips every field; lists and deletes by user",
    async ({ sessions }) => {
      const store = sessions!;
      const [u1, u2] = [uid(), uid()];
      const full = session(u1, {
        mfa: "pending",
        metadata: {
          userAgent: "curl/8.7.1 'O'Reilly' ü",
          ip: "::1",
          tags: ["a", 1],
        },
      });
      const bare = session(u1, { createdAt: at(1), lastActiveAt: at(1) });
      const other = session(u2);
      for (const record of [full, bare, other]) {
        await store.createSession(record);
      }
      same(
        stored(await store.getSession(full.id)),
        full,
        "getSession() returns every field as saved",
      );
      same(
        stored(await store.getSession(bare.id)),
        bare,
        "optional fields come back absent, not null",
      );
      same(
        await store.getSession(id()),
        undefined,
        "getSession() of an unknown id",
      );
      same(
        sortIds(await store.listUserSessions(u1)),
        [full.id, bare.id].sort(),
        "listUserSessions() returns the user's sessions",
      );
      same(
        await store.listUserSessions(uid()),
        [],
        "listUserSessions() of a user without sessions",
      );
      same(
        await store.deleteSession(bare.id),
        true,
        "deleteSession() resolves true when it deleted the session",
      );
      same(
        await store.getSession(bare.id),
        undefined,
        "deleteSession() deletes",
      );
      same(
        await store.deleteSession(bare.id),
        false,
        "deleteSession() of a session already gone resolves false",
      );
      same(
        await store.deleteSession(id()),
        false,
        "deleteSession() of an unknown id resolves false",
      );
      await store.deleteUserSessions(u1);
      same(
        await store.listUserSessions(u1),
        [],
        "deleteUserSessions() deletes the user's sessions",
      );
      same(
        stored(await store.getSession(other.id)),
        other,
        "deleteUserSessions() leaves other users' sessions alone",
      );
    },
  );

  add(
    "sessions",
    "touchSession() moves lastActiveAt forward only, and never recreates a deleted session",
    async ({ sessions }) => {
      const store = sessions!;
      const record = session(uid(), {
        mfa: "verified",
        metadata: { device: "phone" },
      });
      await store.createSession(record);
      await store.touchSession(record.id, at(5_000));
      same(
        stored(await store.getSession(record.id)),
        { ...record, lastActiveAt: at(5_000) },
        "touchSession() changes lastActiveAt, nothing else",
      );
      await store.touchSession(record.id, at(1_000));
      same(
        (await store.getSession(record.id))?.lastActiveAt,
        at(5_000),
        "touchSession() never moves lastActiveAt back",
      );
      await store.deleteSession(record.id);
      await store.touchSession(record.id, at(10_000));
      same(
        await store.getSession(record.id),
        undefined,
        "touchSession() of a deleted session must not bring it back",
      );
      await store.touchSession(id(), at(10_000));
    },
  );

  add(
    "sessions",
    "createSession() prunes only sessions past their absolute expiry, however long idle",
    async ({ sessions }) => {
      const store = sessions!;
      const user = uid();
      const idle = session(user, {
        lastActiveAt: at(0),
        expiresAt: at(3_600_000),
      });
      const expired = session(user, {
        lastActiveAt: at(0),
        expiresAt: at(1_000),
      });
      await store.createSession(idle);
      await store.createSession(expired);
      await store.createSession(
        session(user, { createdAt: at(2_000), lastActiveAt: at(2_000) }),
      );
      same(
        stored(await store.getSession(idle.id)),
        idle,
        "a session idle for a long time, but within its absolute expiry, is kept",
      );
      const left = await store.getSession(expired.id);
      assert.ok(
        left === undefined || left.expiresAt <= at(2_000),
        "a pruned session is gone, or still past its expiry",
      );
    },
  );

  add(
    "sessions",
    "a session another instance touched survives a request that saw it idle (SessionService)",
    async (sources) => {
      const storage = storageOf(sources, "sessions");
      const opts = { idleTtl: "1m" as const, absoluteTtl: "1h" as const, touchInterval: 0 };
      let clock = T0;
      const behind = new SessionService(storage, {
        session: { ...opts, now: () => clock - 2_000 },
      });
      const ahead = new SessionService(storage, {
        session: { ...opts, now: () => clock },
      });
      const { token } = await ahead.create(uid());
      clock += 61_000;
      same(
        await ahead.validate(token),
        null,
        "the request that saw the session idle is refused",
      );
      assert.ok(
        await behind.validate(token),
        "the other instance, within the idle timeout, touches the session",
      );
      clock += 1_000;
      assert.ok(
        await ahead.validate(token),
        "the touched session is still there",
      );
    },
  );

  add(
    "sessions",
    "a request racing a sign-out or a rotation never brings the session back (SessionService)",
    async (sources) => {
      let clock = T0;
      const sessions = new SessionService(storageOf(sources, "sessions"), {
        session: {
          now: () => clock,
          idleTtl: "1m",
          absoluteTtl: "5m",
          touchInterval: "10s",
        },
      });
      const user = uid();
      for (const delay of [0, 1, 2, 3]) {
        const signedOut = await sessions.create(user);
        clock += 20_000;
        await Promise.all([
          sessions.validate(signedOut.token),
          later(delay, () => sessions.revokeAll(user)),
          later(1, () => sessions.validate(signedOut.token)),
        ]);
        same(
          await sessions.validate(signedOut.token),
          null,
          'a session validated during "sign out everywhere" stays deleted',
        );
        const rotated = await sessions.create(user);
        clock += 20_000;
        await Promise.all([
          sessions.validate(rotated.token),
          later(delay, () => sessions.rotate(rotated.session)),
          later(1, () => sessions.validate(rotated.token)),
        ]);
        same(
          await sessions.validate(rotated.token),
          null,
          "a session validated during its rotation stays deleted",
        );
      }
    },
    concurrent,
  );

  add(
    "sessions",
    "of concurrent deletes of one session, exactly one resolves true (what keeps a rotation from outliving a revocation)",
    async ({ sessions }) => {
      const store = sessions!;
      for (let round = 0; round < 3; round++) {
        const record = session(uid());
        await store.createSession(record);
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            later(i % 3, () => store.deleteSession(record.id)),
          ),
        );
        same(
          results.filter((deleted) => deleted === true).length,
          1,
          "one deleteSession() call deleted it, the others found it gone",
        );
      }
    },
    concurrent,
  );

  add(
    "sessions",
    "a rotation racing a sign-out leaves no session, and concurrent rotations leave one (SessionService)",
    async (sources) => {
      const sessions = new SessionService(storageOf(sources, "sessions"), {
        session: { idleTtl: "1m", absoluteTtl: "5m", touchInterval: "10s" },
      });
      for (const delay of [0, 1, 2, 3]) {
        const user = uid();
        const { session: revoked } = await sessions.create(user);
        await Promise.all([
          sessions.rotate(revoked),
          later(delay, () => sessions.revokeAll(user)),
        ]);
        same(
          await sessions.list(user),
          [],
          'no session outlives "sign out everywhere", rotated or not',
        );
        const other = uid();
        const { session: forked } = await sessions.create(other);
        const rotations = await Promise.all([
          sessions.rotate(forked),
          later(delay, () => sessions.rotate(forked)),
        ]);
        same(
          rotations.filter((issued) => issued !== null).length,
          1,
          "one of two concurrent rotations wins",
        );
        same(
          (await sessions.list(other)).length,
          1,
          "a session rotated twice at once does not fork",
        );
      }
    },
    concurrent,
  );

  // ---------------------------------------------------------------- refresh tokens
  add("refreshTokens", "round-trips every field", async ({ refreshTokens }) => {
    const store = refreshTokens!;
    const [user, family] = [uid(), id()];
    const full = refreshToken(user, family, {
      usedAt: at(10),
      claims: {
        amr: ["pwd", "mfa"],
        auth_time: 1_700_000_000,
        nested: { a: [1, "b"] },
      },
    });
    const bare = refreshToken(user, family);
    await store.saveRefreshToken(full);
    await store.saveRefreshToken(bare);
    same(
      await store.getRefreshToken(full.id),
      full,
      "getRefreshToken() returns every field as saved",
    );
    same(
      await store.getRefreshToken(bare.id),
      bare,
      "optional fields come back absent, not null",
    );
    same(
      await store.getRefreshToken(id()),
      undefined,
      "getRefreshToken() of an unknown id",
    );
  });

  add(
    "refreshTokens",
    "markRefreshTokenUsed() succeeds once",
    async ({ refreshTokens }) => {
      const store = refreshTokens!;
      const record = refreshToken(uid(), id());
      await store.saveRefreshToken(record);
      same(
        await store.markRefreshTokenUsed(record.id, at(5)),
        true,
        "the first markRefreshTokenUsed() succeeds",
      );
      same(
        (await store.getRefreshToken(record.id))?.usedAt,
        at(5),
        "usedAt is saved",
      );
      same(
        await store.markRefreshTokenUsed(record.id, at(6)),
        false,
        "a second markRefreshTokenUsed() fails",
      );
      same(
        (await store.getRefreshToken(record.id))?.usedAt,
        at(5),
        "a failed markRefreshTokenUsed() changes nothing",
      );
      same(
        await store.markRefreshTokenUsed(id(), at(6)),
        false,
        "markRefreshTokenUsed() of an unknown id",
      );
    },
  );

  add(
    "refreshTokens",
    "markRefreshTokenUsed() succeeds once under concurrency",
    async ({ refreshTokens }) => {
      const store = refreshTokens!;
      for (let round = 0; round < 3; round++) {
        const record = refreshToken(uid(), id());
        await store.saveRefreshToken(record);
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            store.markRefreshTokenUsed(record.id, at(i + 1)),
          ),
        );
        same(
          results.filter(Boolean).length,
          1,
          "exactly one of 8 parallel markRefreshTokenUsed() calls succeeds",
        );
      }
    },
    concurrent,
  );

  add(
    "refreshTokens",
    "a revoked family stays revoked for tokens saved later; revokeUserRefreshTokens() covers every family of the user",
    async ({ refreshTokens }) => {
      const store = refreshTokens!;
      const [u1, u2] = [uid(), uid()];
      const [f1, f2, f3] = [id(), id(), id()];
      await store.saveRefreshToken(refreshToken(u1, f1));
      await store.saveRefreshToken(refreshToken(u1, f2));
      await store.saveRefreshToken(refreshToken(u2, f3));
      same(
        await store.isRefreshTokenFamilyRevoked(f1),
        false,
        "a new family is not revoked",
      );
      await store.revokeRefreshTokenFamily(f1);
      await store.revokeRefreshTokenFamily(f1);
      await store.saveRefreshToken(refreshToken(u1, f1));
      same(
        await store.isRefreshTokenFamilyRevoked(f1),
        true,
        "a family stays revoked after a successor is saved",
      );
      same(
        await store.isRefreshTokenFamilyRevoked(f2),
        false,
        "revoking a family leaves the user's others alone",
      );
      await store.revokeUserRefreshTokens(u1);
      same(
        await store.isRefreshTokenFamilyRevoked(f2),
        true,
        "revokeUserRefreshTokens() revokes each of the user's families",
      );
      same(
        await store.isRefreshTokenFamilyRevoked(f3),
        false,
        "revokeUserRefreshTokens() leaves other users' families alone",
      );
      const laterFamily = id();
      await store.saveRefreshToken(refreshToken(u1, laterFamily));
      same(
        await store.isRefreshTokenFamilyRevoked(laterFamily),
        false,
        "a family started after revokeUserRefreshTokens() works",
      );
    },
  );

  add(
    "refreshTokens",
    "concurrent refreshes of one token revoke the family (TokenService)",
    async (sources) => {
      const tokens = new TokenService(storageOf(sources, "refreshTokens"), {
        accessToken: { key: SECRET },
        refreshToken: { now: () => T0 },
      });
      for (let round = 0; round < 3; round++) {
        const first = await tokens.issue(uid());
        const results = await Promise.allSettled(
          Array.from({ length: 4 }, () => tokens.refresh(first.refreshToken)),
        );
        const won = results.filter(
          (r): r is PromiseFulfilledResult<{ accessToken: string; refreshToken: string; expiresIn: number }> =>
            r.status === "fulfilled",
        );
        same(
          won.length,
          1,
          "exactly one of 4 parallel refreshes of one token gets a new pair",
        );
        for (const lost of results) {
          if (lost.status === "rejected") {
            assert.match(
              String((lost.reason as { reason?: unknown })?.reason),
              /^(reused|invalid)$/,
              "the others are refused as reused",
            );
          }
        }
        const { value } = won[0]!;
        await assert.rejects(
          tokens.refresh(value.refreshToken),
          { reason: "invalid" },
          "the winner's new token is refused: the family was revoked",
        );
      }
    },
    concurrent,
  );

  // ---------------------------------------------------------------- MFA
  add(
    "mfa",
    "round-trips the authenticator; claimTotpStep() only moves forward; saveTotp() never lowers the claimed step",
    async ({ mfa }) => {
      const store = mfa!;
      const user = uid();
      same(
        await store.getTotp(user),
        undefined,
        "getTotp() of a user without an authenticator",
      );
      same(
        await store.claimTotpStep(user, 5),
        false,
        "claimTotpStep() without an authenticator fails",
      );
      await store.saveTotp(user, { secret: "v1.abc.def", confirmed: false });
      same(
        await store.getTotp(user),
        { secret: "v1.abc.def", confirmed: false },
        "optional fields come back absent, not null",
      );
      same(
        await store.claimTotpStep(user, 100),
        true,
        "the first claim of a step succeeds",
      );
      same(
        await store.claimTotpStep(user, 100),
        false,
        "a step is claimed once",
      );
      same(
        await store.claimTotpStep(user, 99),
        false,
        "an earlier step is refused",
      );
      same(
        await store.claimTotpStep(user, 101),
        true,
        "a later step succeeds",
      );
      await store.saveTotp(user, {
        secret: "v1.new.sec",
        confirmed: true,
        pendingSecret: "v1.p.q",
        lastUsedStep: 50,
      });
      same(
        await store.getTotp(user),
        {
          secret: "v1.new.sec",
          confirmed: true,
          pendingSecret: "v1.p.q",
          lastUsedStep: 101,
        },
        "saveTotp() keeps the larger of the stored and the saved lastUsedStep",
      );
      await store.saveTotp(user, { secret: "v1.new.sec", confirmed: true });
      same(
        (await store.getTotp(user))?.lastUsedStep,
        101,
        "saveTotp() without lastUsedStep keeps the stored one",
      );
      same(
        (await store.getTotp(user))?.pendingSecret,
        undefined,
        "saveTotp() clears pendingSecret when the record has none",
      );
      await store.saveTotp(user, {
        secret: "v1.new.sec",
        confirmed: true,
        lastUsedStep: 200,
      });
      same(
        (await store.getTotp(user))?.lastUsedStep,
        200,
        "saveTotp() raises lastUsedStep",
      );
      await store.saveTotp(user, null);
      same(
        await store.getTotp(user),
        undefined,
        "saveTotp(null) deletes the authenticator",
      );
      await store.saveTotp(user, { secret: "v1.again", confirmed: false });
      same(
        await store.getTotp(user),
        { secret: "v1.again", confirmed: false },
        "a new enrollment starts with no claimed step",
      );
    },
  );

  add(
    "mfa",
    "claimTotpStep() succeeds once under concurrency",
    async ({ mfa }) => {
      const store = mfa!;
      const user = uid();
      await store.saveTotp(user, { secret: "v1.abc.def", confirmed: true });
      for (const step of [100, 101, 102]) {
        const claims = await Promise.all(
          Array.from({ length: 6 }, () => store.claimTotpStep(user, step)),
        );
        same(
          claims.filter(Boolean).length,
          1,
          `exactly one of 6 parallel claims of step ${step} succeeds`,
        );
      }
      const racing = await Promise.all([
        store.claimTotpStep(user, 103),
        store.saveTotp(user, {
          secret: "v1.abc.def",
          confirmed: true,
          lastUsedStep: 102,
        }),
      ]);
      same(racing[0], true, "the claim succeeds");
      same(
        (await store.getTotp(user))?.lastUsedStep,
        103,
        "a saveTotp() racing a claim never reopens the claimed step",
      );
    },
    concurrent,
  );

  add(
    "mfa",
    "recovery codes are replaced as a batch and consumed once, per user",
    async ({ mfa }) => {
      const store = mfa!;
      const [u1, u2] = [uid(), uid()];
      same(
        await store.countRecoveryCodes(u1),
        0,
        "a user without codes has 0",
      );
      await store.saveRecoveryCodes(u1, ["rc1.a", "rc1.b", "rc1.c"]);
      await store.saveRecoveryCodes(u2, ["rc1.a"]);
      same(
        await store.countRecoveryCodes(u1),
        3,
        "countRecoveryCodes() counts the batch",
      );
      same(
        await store.consumeRecoveryCode(u1, "rc1.a"),
        true,
        "a code is consumed",
      );
      same(
        await store.consumeRecoveryCode(u1, "rc1.a"),
        false,
        "a code is consumed once",
      );
      same(
        await store.countRecoveryCodes(u2),
        1,
        "another user's code with the same hash is theirs",
      );
      same(
        await store.consumeRecoveryCode(u1, "rc1.zzz"),
        false,
        "an unknown code",
      );
      await store.saveRecoveryCodes(u1, ["rc1.x"]);
      same(
        await store.consumeRecoveryCode(u1, "rc1.b"),
        false,
        "a new batch replaces the old one",
      );
      same(
        await store.consumeRecoveryCode(u1, "rc1.x"),
        true,
        "the new batch works",
      );
      await store.saveRecoveryCodes(u1, ["rc1.y"]);
      await store.saveRecoveryCodes(u1, []);
      same(
        await store.countRecoveryCodes(u1),
        0,
        "an empty batch deletes the codes",
      );
    },
  );

  add(
    "mfa",
    "consumeRecoveryCode() succeeds once under concurrency",
    async ({ mfa }) => {
      const store = mfa!;
      const user = uid();
      await store.saveRecoveryCodes(user, ["rc1.a", "rc1.b"]);
      const consumed = await Promise.all(
        Array.from({ length: 6 }, () => store.consumeRecoveryCode(user, "rc1.a")),
      );
      same(
        consumed.filter(Boolean).length,
        1,
        "exactly one of 6 parallel consumeRecoveryCode() calls succeeds",
      );
      same(await store.countRecoveryCodes(user), 1, "the code is gone");
    },
    concurrent,
  );

  add(
    "mfa",
    "recordMfaFailure() counts within the window by the caller clock; clearMfaFailures() forgets",
    async ({ mfa }) => {
      const store = mfa!;
      const [u1, u2] = [uid(), uid()];
      same(
        await store.recordMfaFailure(u1, 60_000, T0),
        1,
        "the first failure counts itself",
      );
      same(
        await store.recordMfaFailure(u1, 60_000, T0 + 30_000),
        2,
        "failures within the window add up",
      );
      same(
        await store.countMfaFailures(u1, 60_000, T0 + 30_000),
        2,
        "countMfaFailures() counts without recording",
      );
      same(
        await store.countMfaFailures(u1, 60_000, T0 + 30_000),
        2,
        "countMfaFailures() records nothing",
      );
      same(
        await store.countMfaFailures(u1, 60_000, T0 + 60_000),
        1,
        "a failure exactly windowMs old is out of the window",
      );
      same(
        await store.recordMfaFailure(u1, 60_000, T0 + 60_000),
        2,
        "recordMfaFailure() counts the window too",
      );
      same(
        await store.countMfaFailures(u2, 60_000, T0),
        0,
        "failures are the user's own",
      );
      await store.clearMfaFailures(u1);
      same(
        await store.countMfaFailures(u1, 60_000, T0 + 60_000),
        0,
        "clearMfaFailures() forgets",
      );
    },
  );

  add(
    "mfa",
    "parallel recordMfaFailure() calls never share a low count",
    async ({ mfa }) => {
      const store = mfa!;
      const user = uid();
      const counts = await Promise.all(
        Array.from({ length: 12 }, () => store.recordMfaFailure(user, 60_000, T0)),
      );
      [...counts]
        .sort((a, b) => a - b)
        .forEach((count, i) =>
          assert.ok(
            count >= i + 1,
            `parallel counts ${counts.join(", ")}: two calls saw the same low count`,
          ),
        );
      same(
        Math.max(...counts),
        12,
        "the last of 12 parallel failures counts all 12",
      );
    },
    concurrent,
  );

  add(
    "mfa",
    "a burst of parallel guesses gets maxAttempts checks, not one per request (MfaService)",
    async (sources) => {
      let clock = T0;
      const maxAttempts = 5;
      const events = new AuthenticationEvents();
      const seen: number[] = [];
      events.events$.subscribe((event) => {
        if (event.type === "mfa-failed") {
          seen.push(event.failures);
        }
      });
      const mfa = new MfaService(
        storageOf(sources, "mfa"),
        {
          mfa: {
            now: () => clock,
            maxAttempts,
            encryption: { keys: ["k".repeat(32)] },
          },
        },
        events,
      );
      const user = uid();
      const { secret } = await mfa.enroll(user, "ada");
      const code = (offset = 0) =>
        hotp(base32Decode(secret), Math.floor(clock / 30_000) + offset);
      same(
        await mfa.confirm(user, code()),
        true,
        "the authenticator is confirmed",
      );
      clock += 30_000;
      same(await mfa.verifyTotp(user, code()), true, "a code verifies");
      same(await mfa.verifyTotp(user, code()), false, "a code is accepted once");
      clock += 30_000;
      seen.length = 0;
      const valid = new Set([-1, 0, 1].map((offset) => code(offset)));
      const wrong = Array.from({ length: 20 }, (_, i) =>
        String(i).padStart(6, "0"),
      ).filter((guess) => !valid.has(guess));
      const results = await Promise.all(
        wrong
          .slice(0, maxAttempts * 2 + 1)
          .map((guess) => mfa.verifyTotp(user, guess)),
      );
      same(results.filter(Boolean).length, 0, "every wrong code is refused");
      const checked = seen.filter((failures) => failures < maxAttempts).length;
      assert.ok(
        checked < maxAttempts,
        `of ${results.length} parallel guesses, ${checked} saw a count under maxAttempts (${maxAttempts}): recordMfaFailure() ` +
          "must record the attempt before counting, each committed on its own, so parallel guesses never share a low count",
      );
      same(
        await mfa.verifyTotp(user, code()),
        false,
        "the right code is refused while the lockout lasts",
      );
      clock += 15 * 60_000;
      same(await mfa.verifyTotp(user, code()), true, "the lockout ends");
    },
    concurrent,
  );

  // ---------------------------------------------------------------- magic links, OIDC logins, email tokens
  const pending = <TStore, TRecord>(
    contract: AuthenticationStorageContract,
    kind: string,
    get: (sources: AuthenticationStorageSources) => TStore,
    make: (created: number, expires: number) => TRecord,
    save: (store: TStore, record: TRecord) => Promise<void> | void,
    consume: (
      store: TStore,
      record: TRecord,
    ) => Promise<TRecord | undefined> | TRecord | undefined,
  ) => {
    add(
      contract,
      `hands a ${kind} out once, and drops expired ones as new ones are saved`,
      async (sources) => {
        const store = get(sources);
        const soon = make(0, 1_000);
        const laterRecord = make(0, 900_000);
        await save(store, soon);
        await save(store, laterRecord);
        same(
          await consume(store, laterRecord),
          laterRecord,
          `consume returns the ${kind} as saved`,
        );
        same(
          await consume(store, laterRecord),
          undefined,
          `a ${kind} is consumed once`,
        );
        await save(store, make(1_000, 901_000));
        same(
          await consume(store, soon),
          undefined,
          `an expired ${kind} is deleted when a new one is saved`,
        );
      },
    );
    add(
      contract,
      `hands a ${kind} out once under concurrency`,
      async (sources) => {
        const store = get(sources);
        for (let round = 0; round < 3; round++) {
          const record = make(0, 900_000);
          await save(store, record);
          const results = await Promise.all(
            Array.from({ length: 6 }, () => consume(store, record)),
          );
          const won = results.filter((result) => result !== undefined);
          same(
            won.length,
            1,
            `exactly one of 6 parallel consumes gets the ${kind}`,
          );
          same(won[0], record, `the winner gets the ${kind} as saved`);
        }
      },
      concurrent,
    );
    add(
      contract,
      `keeps at most maxPending ${kind}s, dropping those that expire first`,
      async (sources) => {
        const store = get(sources);
        const records = Array.from({ length: maxPending! + 2 }, (_, i) =>
          make(i, 900_000 + i),
        );
        for (const record of records) {
          await save(store, record);
        }
        same(
          await consume(store, records[0]!),
          undefined,
          `the ${kind} that expires first is dropped`,
        );
        same(
          await consume(store, records[1]!),
          undefined,
          `the ${kind} that expires second is dropped`,
        );
        for (const record of records.slice(2)) {
          same(
            await consume(store, record),
            record,
            `the other ${kind}s are kept`,
          );
        }
      },
      maxPending !== undefined,
    );
  };

  pending<NonNullable<AuthenticationStorageSources["magicLinks"]>, MagicLinkRecord>(
    "magicLinks",
    "link",
    (sources) => sources.magicLinks!,
    (created, expires) => ({
      id: id(),
      email: `${uid()}@example.com`,
      createdAt: at(created),
      expiresAt: at(expires),
      ...(created % 2 === 0 ? { redirectTo: "/orders?x=1&y=ü" } : {}),
    }),
    (store, record) => store.saveMagicLink(record),
    (store, record) => store.consumeMagicLink(record.id),
  );

  pending<NonNullable<AuthenticationStorageSources["oidcStates"]>, OidcTransaction>(
    "oidcStates",
    "login",
    (sources) => sources.oidcStates!,
    (created, expires) =>
      created % 2 === 0
        ? {
            state: id(),
            provider: "google",
            nonce: id(),
            codeVerifier: id(),
            redirectTo: "/orders",
            createdAt: at(created),
            expiresAt: at(expires),
            link: { userId: uid(), sessionId: id() },
          }
        : {
            state: id(),
            provider: "github",
            codeVerifier: id(),
            createdAt: at(created),
            expiresAt: at(expires),
          },
    (store, record) => store.saveOidcState(record),
    (store, record) => store.consumeOidcState(record.state),
  );

  pending<NonNullable<AuthenticationStorageSources["emailTokens"]>, EmailTokenRecord>(
    "emailTokens",
    "token",
    (sources) => sources.emailTokens!,
    (created, expires) =>
      emailToken({
        createdAt: at(created),
        expiresAt: at(expires),
        ...(created % 2 === 0 ? { fingerprint: id() } : {}),
      }),
    (store, record) => store.saveEmailToken(record),
    (store, record) => store.consumeEmailToken(record.id, record.purpose),
  );

  add(
    "emailTokens",
    "a token is consumed only for its purpose; deleteUserEmailTokens() is per user and purpose",
    async ({ emailTokens }) => {
      const store = emailTokens!;
      const [u1, u2] = [uid(), uid()];
      const reset = emailToken({ userId: u1, fingerprint: "fp" });
      const verify = emailToken({ userId: u1, purpose: "email-verification" });
      const other = emailToken({ userId: u2 });
      for (const record of [reset, verify, other]) {
        await store.saveEmailToken(record);
      }
      same(
        await store.consumeEmailToken(reset.id, "email-verification"),
        undefined,
        "a token of another purpose is refused",
      );
      same(
        await store.consumeEmailToken(reset.id, "password-reset"),
        reset,
        "…and left in place",
      );
      await store.saveEmailToken(reset);
      same(
        await store.consumeEmailToken(reset.id, "password-reset"),
        reset,
        "a consumed token can be saved back, and works once more",
      );
      const second = emailToken({ userId: u1 });
      await store.saveEmailToken(second);
      await store.deleteUserEmailTokens(u1, "password-reset");
      same(
        await store.consumeEmailToken(second.id, "password-reset"),
        undefined,
        "deleteUserEmailTokens() deletes the user's tokens of that purpose",
      );
      same(
        await store.consumeEmailToken(verify.id, "email-verification"),
        verify,
        "deleteUserEmailTokens() leaves other purposes alone",
      );
      same(
        await store.consumeEmailToken(other.id, "password-reset"),
        other,
        "deleteUserEmailTokens() leaves other users' tokens alone",
      );
    },
  );

  add(
    "emailTokens",
    "password reset and verification links work once under concurrency (the services)",
    async (sources) => {
      const storage = storageOf(sources, "emailTokens");
      const hasher = new PasswordHasher({ logN: 10 });
      const account = {
        id: uid(),
        email: `${uid()}@example.com`,
        passwordHash: await hasher.hash("old password"),
        verified: false,
      };
      const mails: string[] = [];
      const resets = new (class extends PasswordResetHandler {
        findUser(email: string) {
          return email === account.email
            ? {
                id: account.id,
                email: account.email,
                passwordHash: account.passwordHash,
              }
            : null;
        }
        send({ url }: { url: string }) {
          mails.push(url);
        }
        updatePassword(_userId: string, hash: string) {
          account.passwordHash = hash;
        }
      })();
      const verification = new (class extends EmailVerificationHandler {
        send({ url }: { url: string }) {
          mails.push(url);
        }
        markVerified(userId: string, email: string) {
          if (userId !== account.id || email !== account.email) {
            return false;
          }
          account.verified = true;
          return true;
        }
      })();
      const events = new AuthenticationEvents();
      const sessions = new SessionService(storage, {}, events);
      const tokens = new TokenService(storage, {}, events);
      const signIn = new SignInService(
        sessions,
        new MfaService(storage, {}),
        tokens,
        undefined,
        undefined,
        events,
      );
      const opts = {
        passwordReset: { url: "https://app.test/reset" },
        emailVerification: { url: "https://app.test/verify" },
      };
      const registry = new AuthenticationRegistry(opts);
      registry.registerHandler("passwordReset", resets);
      registry.registerHandler("emailVerification", verification);
      registry[LOCK_REGISTRY]({ log: false });
      const passwordResets = new PasswordResetService(
        storage,
        registry,
        hasher,
        sessions,
        tokens,
        signIn,
        opts,
        events,
      );
      const emailVerification = new EmailVerificationService(
        storage,
        registry,
        opts,
        events,
      );
      const token = () => new URL(mails.at(-1)!).searchParams.get("token")!;
      await emailVerification.send(account);
      const verifyToken = token();
      const verified = await Promise.all(
        Array.from({ length: 4 }, () => emailVerification.verify(verifyToken)),
      );
      same(
        verified.filter(Boolean).length,
        1,
        "exactly one of 4 parallel verifications of one link succeeds",
      );
      same(account.verified, true, "the address is verified");
      account.verified = false;
      passwordResets.request(account.email.toUpperCase());
      await passwordResets.onModuleDestroy();
      const resetToken = token();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          passwordResets.reset(resetToken, "new password"),
        ),
      );
      same(
        results.filter(Boolean),
        [{ userId: account.id }],
        "exactly one of 4 parallel resets with one link succeeds",
      );
      same(
        await hasher.verify("new password", account.passwordHash),
        true,
        "the new password is set",
      );
      same(account.verified, true, "the reset link proved the address");
    },
    concurrent,
  );

  return cases;
}

// ---------------------------------------------------------------- helpers

async function fresh(
  create: AuthenticationStoreFactory,
  contract: AuthenticationStorageContract,
): Promise<AuthenticationStorageSources> {
  const sources = await create();
  if (!sources || typeof sources !== "object" || !sources[contract]) {
    throw new Error(
      `authenticationStoreContract(): create() returned no \`${contract}\` store. Return it, or leave \`${contract}\` out of \`contracts\`.`,
    );
  }
  return sources;
}

function storageOf(
  sources: AuthenticationStorageSources,
  contract: AuthenticationStorageContract,
): AuthenticationStorage {
  const storage = new AuthenticationStorage({
    contracts: [],
    allowInMemoryStorage: true,
  });
  storage.registerSource({ [contract]: sources[contract] });
  storage[LOCK_STORAGE]({ log: false });
  return storage;
}

const id = (): string => randomUUID().replaceAll("-", "");

async function later<T>(turns: number, fn: () => Promise<T> | T): Promise<T> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return fn();
}

const uid = (): string => `user-${randomUUID()}`;

function session(
  userId: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id: id(),
    userId,
    createdAt: at(0),
    expiresAt: at(3_600_000),
    lastActiveAt: at(0),
    ...overrides,
  };
}

function refreshToken(
  userId: string,
  familyId: string,
  overrides: Partial<RefreshTokenRecord> = {},
): RefreshTokenRecord {
  return {
    id: id(),
    familyId,
    userId,
    createdAt: at(0),
    expiresAt: at(60_000),
    familyExpiresAt: at(120_000),
    ...overrides,
  };
}

function emailToken(
  overrides: Partial<EmailTokenRecord> = {},
): EmailTokenRecord {
  return {
    id: id(),
    purpose: "password-reset",
    userId: uid(),
    email: `${uid()}@example.com`,
    createdAt: at(0),
    expiresAt: at(60_000),
    ...overrides,
  };
}

const sortIds = (records: SessionRecord[]): string[] =>
  records.map((record) => record.id).sort();

function stored(
  record: SessionRecord | undefined,
): Omit<SessionRecord, "extra"> | undefined {
  if (!record) {
    return record;
  }
  const { extra: _extra, ...rest } = record;
  return rest;
}

function same(actual: unknown, expected: unknown, message: string): void {
  assert.deepStrictEqual(normalize(actual), normalize(expected), message);
}

function normalize(value: unknown): unknown {
  if (value instanceof Date || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, normalize(entry)]),
  );
}
