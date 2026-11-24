import { describe, expect, it } from "bun:test";
import {
  InMemoryEmailTokenStore,
  InMemoryMagicLinkStore,
  InMemoryMfaStore,
  InMemoryOidcStateStore,
  InMemoryRefreshTokenStore,
  InMemorySessionStore,
} from "../../src/auth-next/index";
import { authenticationStoreContract } from "../../src/auth-next/testing/index";

describe("@bunest/authentication/testing store contract suite", () => {
  const cases = authenticationStoreContract(
    () => ({
      sessions: new InMemorySessionStore(),
      refreshTokens: new InMemoryRefreshTokenStore(),
      mfa: new InMemoryMfaStore(),
      magicLinks: new InMemoryMagicLinkStore(),
      oidcStates: new InMemoryOidcStateStore(),
      emailTokens: new InMemoryEmailTokenStore(),
    }),
    { concurrent: true },
  );

  for (const c of cases) {
    it(c.name, async () => {
      await c.run();
    });
  }

  it("rejects unknown contract names and invalid maxPending", () => {
    expect(() =>
      authenticationStoreContract(() => ({}), {
        contracts: ["unknown" as any],
      }),
    ).toThrow(TypeError);

    expect(() =>
      authenticationStoreContract(() => ({}), {
        maxPending: 0,
      }),
    ).toThrow(TypeError);
  });
});
