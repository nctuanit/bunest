import { expect, it } from "bun:test";
import { AuthGuard } from "../../../../../packages/security/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

describeConformance(
  "AuthGuard memoization",
  {
    upstreamPath: "passport/test/utils/memoize.spec.ts",
    category: "ADAPTED_PORT",
    notes:
      "Upstream commit 19422a37af (@nestjs/passport@12.0.2). Bunest embeds Map-backed memoization directly inside AuthGuard(type) instead of exporting an internal memoize() utility; all 5 cache-key invariants are tested via AuthGuard().",
  },
  () => {
    it("caches by key and returns the exact same guard class per key", () => {
      const a1 = AuthGuard("memo-a");
      const a2 = AuthGuard("memo-a");
      const b1 = AuthGuard("memo-b");

      expect(a1).toBe(a2);
      expect(b1).not.toBe(a1);
    });

    it("caches the default key when called with undefined or no arguments", () => {
      const d1 = AuthGuard();
      const d2 = AuthGuard(undefined);
      const namedDefault = AuthGuard("__default__");

      expect(d1).toBe(d2);
      expect(typeof d1).toBe("function");
      expect(namedDefault).not.toBe(d1);
    });

    it("returns the same guard class for arrays with identical contents and distinct classes for reordered arrays", () => {
      expect(AuthGuard(["memo-a", "memo-b"])).toBe(
        AuthGuard(["memo-a", "memo-b"]),
      );
      expect(AuthGuard(["memo-a", "memo-b"])).not.toBe(
        AuthGuard(["memo-b", "memo-a"]),
      );
    });

    itAdapted(
      "ADR-001",
      "distinguishes comma-containing strategy names from multi-strategy arrays and normalizes single string/array identically",
      () => {
        const single = AuthGuard("memo-single");
        const singleArray = AuthGuard(["memo-single"]);
        // Bunest normalizes string `type` to `[type]` for `strategyList`, so both share the exact same guard class.
        expect(singleArray).toBe(single);
        // Comma in a strategy name must NEVER collide with a two-element array.
        expect(AuthGuard(["memo-a,memo-b"])).not.toBe(
          AuthGuard(["memo-a", "memo-b"]),
        );
      },
      "Bunest AuthGuard normalizes single string to 1-element strategyList before JSON.stringify cache key",
    );

    it("does not confuse keys that shadow Object.prototype members", () => {
      const protoKeys = [
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
      ];
      const guards = protoKeys.map((key) => AuthGuard(key));

      for (const guardClass of guards) {
        expect(typeof guardClass).toBe("function");
        expect(guardClass).not.toBe(Object as unknown);
        expect(guardClass).not.toBe(Object.prototype as unknown);
      }

      // Each distinct Object.prototype-shadowing key produces its own memoized guard class.
      expect(new Set(guards).size).toBe(protoKeys.length);

      // Re-fetching returns the exact memoized class.
      for (let i = 0; i < protoKeys.length; i++) {
        expect(AuthGuard(protoKeys[i]!)).toBe(guards[i]!);
      }
    });
  },
);
