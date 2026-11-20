import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  toCamelCase,
  toKebabCase,
  toPascalCase,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

describeConformance(
  "Formatting Utilities (toKebabCase / toPascalCase / toCamelCase)",
  {
    upstreamPath: "nest-cli/test/lib/utils/formatting.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS `normalizeToKebabOrSnakeCase` tests to Bunest's `toKebabCase`, `toPascalCase`, and `toCamelCase` helpers in `packages/cli/src/utils/naming.ts`.",
  },
  () => {
    describe("toKebabCase", () => {
      it("should convert camelCase to kebab-case", () => {
        expect(toKebabCase("myModule")).toBe("my-module");
      });

      it("should convert PascalCase to kebab-case", () => {
        expect(toKebabCase("MyModule")).toBe("my-module");
      });

      it("should convert multi-word camelCase to kebab-case", () => {
        expect(toKebabCase("myNewModule")).toBe("my-new-module");
      });

      it("should replace spaces with dashes", () => {
        expect(toKebabCase("my module")).toBe("my-module");
      });

      it("should replace multiple spaces with dashes", () => {
        expect(toKebabCase("my new module")).toBe("my-new-module");
      });

      it("should lowercase uppercase strings", () => {
        expect(toKebabCase("MYMODULE")).toBe("mymodule");
      });

      itAdapted(
        ["ADR-001"],
        "should normalize snake_case underscores to dashes (pure kebab-case)",
        () => {
          expect(toKebabCase("my_module")).toBe("my-module");
        },
      );

      it("should handle already kebab-case strings", () => {
        expect(toKebabCase("my-module")).toBe("my-module");
      });

      it("should handle single word strings", () => {
        expect(toKebabCase("module")).toBe("module");
      });

      it("should handle empty string", () => {
        expect(toKebabCase("")).toBe("");
      });

      it("should handle camelCase with numbers", () => {
        expect(toKebabCase("module1Name")).toBe("module1-name");
      });

      it("should handle mixed spaces and camelCase", () => {
        expect(toKebabCase("myModule name")).toBe("my-module-name");
      });

      itAdapted(
        ["ADR-001"],
        "should split acronym boundaries before capitalized words (myHTTPServer -> my-http-server)",
        () => {
          expect(toKebabCase("myHTTPServer")).toBe("my-http-server");
        },
      );

      it("should handle strings with tabs by replacing them with dashes", () => {
        expect(toKebabCase("my\tmodule")).toBe("my-module");
      });
    });

    describe("toPascalCase and toCamelCase", () => {
      it("converts kebab-case, snake_case, camelCase, and spaced inputs consistently", () => {
        expect(toPascalCase("user-profile")).toBe("UserProfile");
        expect(toPascalCase("my_new_module")).toBe("MyNewModule");
        expect(toPascalCase("myHTTPServer")).toBe("MyHttpServer");
        expect(toPascalCase("")).toBe("");

        expect(toCamelCase("user-profile")).toBe("userProfile");
        expect(toCamelCase("MyModule")).toBe("myModule");
        expect(toCamelCase("my_new_module")).toBe("myNewModule");
        expect(toCamelCase("")).toBe("");
      });
    });
  },
);
