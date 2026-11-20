import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import {
  PassportStrategy,
  defaultPassportInstance,
} from "../../../../../packages/security/src";
import { describeConformance } from "../../../_helpers/index";

/**
 * Minimal zero-dependency Passport-local compatible base Strategy class
 * storing the verify callback on `_verify` (mirroring `passport-local`'s Strategy).
 */
class MockLocalStrategy {
  name = "local";
  _verify: (...args: unknown[]) => unknown;
  _options: Record<string, unknown>;

  constructor(verify: (...args: unknown[]) => unknown);
  constructor(
    options: Record<string, unknown>,
    verify: (...args: unknown[]) => unknown,
  );
  constructor(
    optionsOrVerify: Record<string, unknown> | ((...args: unknown[]) => unknown),
    verify?: (...args: unknown[]) => unknown,
  ) {
    if (typeof optionsOrVerify === "function") {
      this._options = {};
      this._verify = optionsOrVerify;
    } else {
      this._options = optionsOrVerify ?? {};
      this._verify = verify!;
    }
  }
}

describeConformance(
  "PassportStrategy callbackArity",
  {
    upstreamPath: "passport/test/common/passport-strategy.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Upstream commit 19422a37af (@nestjs/passport@12.0.2). Uses a zero-dep MockLocalStrategy capturing `_verify` instead of the `passport-local` npm package.",
  },
  () => {
    afterEach(() => {
      defaultPassportInstance.clear();
    });

    it("should derive the verify callback arity from a validate method", () => {
      class MethodStrategy extends PassportStrategy(
        MockLocalStrategy,
        "arity-method",
        true,
      ) {
        validate(username: string, password: string) {
          return { username, password };
        }
      }

      const strategy = new MethodStrategy() as unknown as {
        _verify: (...args: unknown[]) => unknown;
      };
      expect(strategy._verify.length).toBe(3);
    });

    it("should not throw when validate is not defined on the prototype", () => {
      class PropertyStrategy extends PassportStrategy(
        MockLocalStrategy,
        "arity-property",
        true,
      ) {
        validate = (username: string, password: string) => ({
          username,
          password,
        });
      }

      expect(() => new PropertyStrategy()).not.toThrow();
    });

    it("should apply an explicit arity when validate is not defined on the prototype", () => {
      class PropertyStrategy extends PassportStrategy(
        MockLocalStrategy,
        "arity-explicit",
        3,
      ) {
        validate = (username: string, password: string) => ({
          username,
          password,
        });
      }

      const strategy = new PropertyStrategy() as unknown as {
        _verify: (...args: unknown[]) => unknown;
      };
      expect(strategy._verify.length).toBe(3);
    });
  },
);
