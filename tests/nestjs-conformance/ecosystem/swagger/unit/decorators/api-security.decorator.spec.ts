import { describe, expect, it } from "bun:test";
import { MetadataRegistry } from "../../../../../../packages/core/src/common";
import {
  ApiBearerAuth,
  ApiSecurity,
  SWAGGER_METADATA_KEYS,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ApiSecurity",
  {
    upstreamPath: "test/decorators/api-security.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores @ApiSecurity metadata via MetadataRegistry under SWAGGER_METADATA_KEYS.API_SECURITY (ADR-002).",
  },
  () => {
    describe("when several decorators are applied to the same target", () => {
      @ApiSecurity("first")
      @ApiSecurity({ second: ["read"] })
      class TestController {
        @ApiSecurity("first")
        @ApiSecurity("second", ["read"])
        public method(): void {}
      }

      it("should merge the requirements on a method", () => {
        expect(
          MetadataRegistry.get(
            SWAGGER_METADATA_KEYS.API_SECURITY,
            TestController.prototype.method,
          ),
        ).toEqual([{ second: ["read"] }, { first: [] }]);
      });

      it("should merge the requirements on a class", () => {
        expect(
          MetadataRegistry.get(
            SWAGGER_METADATA_KEYS.API_SECURITY,
            TestController,
          ),
        ).toEqual([{ second: ["read"] }, { first: [] }]);
      });
    });

    describe("when the same decorator instance is applied to several targets", () => {
      const JwtAuth = ApiBearerAuth();

      class TestController {
        @JwtAuth
        @ApiSecurity("partner-key")
        public withOtherRequirement(): void {}

        @JwtAuth
        public withoutOtherRequirement(): void {}
      }

      @JwtAuth
      class OtherController {}

      it("should merge with the requirements of the decorated target", () => {
        expect(
          MetadataRegistry.get(
            SWAGGER_METADATA_KEYS.API_SECURITY,
            TestController.prototype.withOtherRequirement,
          ),
        ).toEqual([{ "partner-key": [] }, { bearer: [] }]);
      });

      it("should not carry the requirements of one method over to another", () => {
        expect(
          MetadataRegistry.get(
            SWAGGER_METADATA_KEYS.API_SECURITY,
            TestController.prototype.withoutOtherRequirement,
          ),
        ).toEqual([{ bearer: [] }]);
      });

      it("should not carry the requirements of a method over to a class", () => {
        expect(
          MetadataRegistry.get(
            SWAGGER_METADATA_KEYS.API_SECURITY,
            OtherController,
          ),
        ).toEqual([{ bearer: [] }]);
      });
    });
  },
);
