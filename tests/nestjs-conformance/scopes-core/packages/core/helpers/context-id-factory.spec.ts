import { expect, it } from "bun:test";
import { createContextId } from "../../../../../../packages/core/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "createContextId",
  {
    upstreamPath: "packages/core/test/helpers/context-id-factory.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-012"],
  },
  () => {
    it('should return an object with "id" property', () => {
      expect(createContextId()).toHaveProperty("id");
    });
  },
);
