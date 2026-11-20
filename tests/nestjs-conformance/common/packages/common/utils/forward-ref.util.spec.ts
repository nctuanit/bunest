import "reflect-metadata";
import { expect, it } from "bun:test";
import { forwardRef } from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "forwardRef",
  {
    upstreamPath: "packages/common/test/utils/forward-ref.util.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return object with forwardRef property", () => {
      const fn = () => ({});
      const referenceFn = forwardRef(() => fn);
      expect(referenceFn.forwardRef()).toEqual(fn);
    });
  },
);
