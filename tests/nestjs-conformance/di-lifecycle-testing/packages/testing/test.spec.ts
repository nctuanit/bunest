import { expect, it } from "bun:test";
import {
  Test,
  TestingModuleBuilder,
  describeConformance,
} from "../../../_helpers";

describeConformance(
  "Test",
  {
    upstreamPath: "packages/testing/test/test.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("createTestingModule should return a TestingModuleBuilder instance", () => {
      const builder = Test.createTestingModule({});
      expect(builder).toBeInstanceOf(TestingModuleBuilder);
    });

    it("createTestingModule should accept options and return a TestingModuleBuilder", () => {
      const builder = Test.createTestingModule({}, { logger: false });
      expect(builder).toBeInstanceOf(TestingModuleBuilder);
    });
  },
);
