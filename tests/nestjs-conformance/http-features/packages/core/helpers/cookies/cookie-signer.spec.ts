import { expect, it } from "bun:test";
import {
  normalizeCookieSecrets,
  signCookieValue,
  unsignCookieValue,
} from "../../../../../../../packages/core/src/http";
import { describeConformance, itAdapted } from "../../../../../_helpers";

/**
 * Reference cookie-signature HMAC-SHA256 implementation (standard base64 without `=` padding).
 */
function referenceCookieSignatureSign(value: string, secret: string): string {
  const sig = new Bun.CryptoHasher("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/=+$/, "");
  return `${value}.${sig}`;
}

function referenceCookieSignatureUnsign(
  signed: string,
  secret: string,
): string | false {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return false;
  const val = signed.slice(0, idx);
  return referenceCookieSignatureSign(val, secret) === signed ? val : false;
}

describeConformance(
  "CookieSigner (Bunest signCookieValue / unsignCookieValue / normalizeCookieSecrets)",
  {
    upstreamPath: "packages/core/test/helpers/cookies/cookie-signer.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS CookieSigner class tests to Bunest @bunest/http functional cookie signing APIs (normalizeCookieSecrets, signCookieValue, unsignCookieValue).",
  },
  () => {
    it("should reject missing or empty secrets", () => {
      for (const secret of ["", [], [""], ["a", ""], [1]]) {
        expect(() => normalizeCookieSecrets(secret as any)).toThrow();
      }
      // In Bunest, undefined means "signing not configured" and returns undefined
      expect(normalizeCookieSecrets(undefined)).toBeUndefined();
    });

    it('should produce the cookie-signature format with the "s:" prefix', () => {
      const signed = signCookieValue("value", "secret");
      expect(signed).toBe(
        `s:${referenceCookieSignatureSign("value", "secret")}`,
      );
      expect(signed).not.toMatch(/=$/);
    });

    it("should round-trip non-empty values, including dots and non-ASCII", () => {
      for (const value of ["a.b.c", "h\u00e9llo", "s:nested"]) {
        expect(
          unsignCookieValue(signCookieValue(value, "secret"), ["secret"]),
        ).toBe(value);
      }
    });

    it("should round-trip empty string values", () => {
      expect(unsignCookieValue(signCookieValue("", "secret"), ["secret"])).toBe(
        "",
      );
    });

    it("should verify values signed by cookie-signature, with or without the prefix", () => {
      const signed = referenceCookieSignatureSign("user-42", "secret");
      expect(unsignCookieValue(`s:${signed}`, ["secret"])).toBe("user-42");
      expect(unsignCookieValue(signed, ["secret"])).toBe("user-42");
    });

    it("should produce values that cookie-signature verifies", () => {
      const signed = signCookieValue("user-42", "secret");
      expect(referenceCookieSignatureUnsign(signed.slice(2), "secret")).toBe(
        "user-42",
      );
    });

    itAdapted(
      "ADR-001",
      "should reject tampered values and signatures",
      () => {
        const signed = signCookieValue("user-42", "secret");
        expect(
          unsignCookieValue(signed.replace("user-42", "user-43"), ["secret"]),
        ).toBe(false);
        expect(unsignCookieValue(signed.slice(0, -1), ["secret"])).toBe(false);
        expect(unsignCookieValue(`${signed}A`, ["secret"])).toBe(false);
        expect(unsignCookieValue("s:user-42", ["secret"])).toBe(false);
        expect(unsignCookieValue("user-42", ["secret"])).toBe(false);
        expect(unsignCookieValue("", ["secret"])).toBe(false);
      },
      "unsignCookieValue returns false on invalid signature",
    );

    it("should return false rather than throwing for undefined input", () => {
      expect(unsignCookieValue(undefined as any, ["secret"])).toBe(false);
    });

    itAdapted(
      "ADR-001",
      "should reject values signed with another secret",
      () => {
        const signed = signCookieValue("user-42", "other");
        expect(unsignCookieValue(signed, ["secret"])).toBe(false);
      },
      "unsignCookieValue returns false for mismatched secret",
    );

    it("should sign with the first secret and verify with all of them", () => {
      const rotated = normalizeCookieSecrets(["new", "old"])!;
      const signedWithOld = signCookieValue("v", "old");
      const signedWithNew = signCookieValue("v", rotated[0]!);
      expect(unsignCookieValue(signedWithOld, rotated)).toBe("v");
      expect(signedWithNew).toBe(signCookieValue("v", "new"));
      expect(unsignCookieValue(signedWithNew, ["old"])).toBe(false);
    });

    it("should not be affected by mutating the secrets array afterwards", () => {
      const secrets = ["a"];
      const normalized = normalizeCookieSecrets(secrets)!;
      const signed = signCookieValue("v", normalized[0]!);
      secrets[0] = "b";
      expect(unsignCookieValue(signed, normalized)).toBe("v");
    });
  },
);
