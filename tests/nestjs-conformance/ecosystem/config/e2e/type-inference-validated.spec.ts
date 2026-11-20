import "reflect-metadata";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ConfigService } from "../../../../../packages/config/src";
import { describeConformance } from "../../../_helpers/index";

/**
 * Type tests for ConfigService with WasValidated parameter.
 * Verifies fix for upstream issue #2182: TypeScript type checking inconsistency
 * with optional fields.
 *
 * Uses @ts-expect-error to verify that TypeScript correctly detects type errors
 * when assigning potentially undefined values to strict types.
 */
type ConfigWithOptional = {
  OPTIONAL_KEY: string | undefined;
  REQUIRED_KEY: string;
};

describeConformance(
  "Type inference with WasValidated parameter",
  {
    upstreamPath: "config/tests/e2e/type-inference-validated.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("ConfigService<Config, true> (validated)", () => {
      let configService: ConfigService<ConfigWithOptional, true>;

      beforeEach(() => {
        configService = {
          get: mock(() => "test-value"),
          getOrThrow: mock(() => "test-value"),
        } as unknown as ConfigService<ConfigWithOptional, true>;
      });

      it("should correctly type optional fields as string | undefined", () => {
        const value = configService.get("OPTIONAL_KEY", { infer: true });

        expect(value).toBeDefined();

        const _acceptsUndefined: string | undefined = value;
        expect(_acceptsUndefined).toBeDefined();

        // @ts-expect-error Type 'string | undefined' is not assignable to type 'string'
        const _strictString: string = value;
        expect(_strictString).toBeDefined();
      });

      it("should correctly type required fields as string", () => {
        const value = configService.get("REQUIRED_KEY", { infer: true });

        expect(value).toBeDefined();

        const _strictString: string = value;
        expect(_strictString).toBeDefined();
      });

      it("should return non-undefined type when default value is provided", () => {
        const value = configService.get("OPTIONAL_KEY", "default", {
          infer: true,
        });

        expect(value).toBeDefined();

        const _strictString: string = value;
        expect(_strictString).toBeDefined();
      });

      it("should correctly type getOrThrow as excluding undefined", () => {
        const value = configService.getOrThrow("OPTIONAL_KEY", { infer: true });

        expect(value).toBeDefined();

        const _strictString: string = value;
        expect(_strictString).toBeDefined();
      });
    });

    describe("ConfigService<Config, false> (not validated)", () => {
      let configService: ConfigService<ConfigWithOptional, false>;

      beforeEach(() => {
        configService = {
          get: mock(() => "test-value"),
          getOrThrow: mock(() => "test-value"),
        } as unknown as ConfigService<ConfigWithOptional, false>;
      });

      it("should add undefined to all types when not validated", () => {
        const optionalValue = configService.get("OPTIONAL_KEY", {
          infer: true,
        });
        const requiredValue = configService.get("REQUIRED_KEY", {
          infer: true,
        });

        expect(optionalValue).toBeDefined();
        expect(requiredValue).toBeDefined();

        // @ts-expect-error Type 'string | undefined' is not assignable to type 'string'
        const _strictOptional: string = optionalValue;

        // @ts-expect-error Type 'string | undefined' is not assignable to type 'string'
        const _strictRequired: string = requiredValue;

        expect(_strictOptional).toBeDefined();
        expect(_strictRequired).toBeDefined();
      });
    });
  },
);
