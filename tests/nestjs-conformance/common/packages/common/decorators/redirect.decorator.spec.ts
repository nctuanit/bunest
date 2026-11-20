import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  HttpStatus,
  METADATA_KEYS,
  MetadataRegistry,
  Redirect,
  type RedirectMetadata,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@Redirect",
  {
    upstreamPath: "packages/common/test/decorators/redirect.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    const url = "http://test.com";
    const statusCode = HttpStatus.FOUND;

    class Test {
      @Redirect(url, statusCode)
      public static test() {}
    }

    it("should enhance method with expected redirect url string", () => {
      const metadata = MetadataRegistry.get<RedirectMetadata>(
        METADATA_KEYS.REDIRECT,
        Test.test,
      );
      expect(metadata?.url).toEqual(url);
    });

    it("should enhance method with expected response code", () => {
      const metadata = MetadataRegistry.get<RedirectMetadata>(
        METADATA_KEYS.REDIRECT,
        Test.test,
      );
      expect(metadata?.statusCode).toEqual(statusCode);
    });
  },
);
