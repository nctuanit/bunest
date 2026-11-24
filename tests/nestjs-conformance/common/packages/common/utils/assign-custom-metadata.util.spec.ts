import { expect, it } from "bun:test";
import {
  MetadataRegistry,
  assignMetadata,
  createParamDecorator,
  type PipeTransform,
} from "../../../../../../packages/core/src/common";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "assignCustomParameterMetadata / assignMetadata",
  {
    upstreamPath:
      "packages/common/test/utils/assign-custom-metadata.util.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-004"],
    notes:
      "Upstream internal assignCustomParameterMetadata() is not publicly exported by NestJS; adapted to @bunest/common public assignMetadata() and ADR-004 createParamDecorator() / MetadataRegistry.getRouteParameters().",
  },
  () => {
    const factory = (data: unknown, _context: unknown) => data;
    const mockPipe: PipeTransform = { transform: () => null };

    itAdapted(
      "ADR-004",
      "should use the correct composite key format in assignMetadata",
      () => {
        const args = {};
        const result = assignMetadata(args, "abc", 2);
        expect(result).toHaveProperty("abc:2");
      },
      "assignMetadata key format",
    );

    itAdapted(
      "ADR-004",
      "should preserve existing args in the returned object",
      () => {
        const args = { 0: { index: 0, data: "existing" } };
        const result = assignMetadata(args, "xyz", 1);
        expect(result["0"]).toEqual({ index: 0, data: "existing" });
      },
    );

    itAdapted(
      "ADR-004",
      "should store index, data, and pipes in assignMetadata and factory via createParamDecorator",
      () => {
        const data = { param: "value" };
        const pipes = [mockPipe];
        const result = assignMetadata({}, "def", 3, data, ...pipes);
        const entry = result["def:3"];
        expect(entry).toBeDefined();
        expect(entry!.index).toBe(3);
        expect(entry!.data).toEqual(data);
        expect(entry!.pipes).toEqual(pipes);

        // Verify custom parameter decorator metadata stores index, factory, data, and pipes
        const CustomDec = createParamDecorator(factory);
        class TestController {
          handler(
            _a: unknown,
            _b: unknown,
            _c: unknown,
            @CustomDec(data, mockPipe) _d: unknown,
          ) {}
        }

        const params = MetadataRegistry.getRouteParameters(
          TestController,
          "handler",
        );
        expect(params).toHaveLength(1);
        expect(params[0]?.index).toBe(3);
        expect(params[0]?.factory).toBe(factory);
        expect(params[0]?.data).toBe(data);
        expect(params[0]?.pipes).toEqual(pipes);
      },
      "assignMetadata + createParamDecorator",
    );

    it("should set data to undefined when not provided", () => {
      const result = assignMetadata({}, "a", 0);
      expect(result["a:0"]?.data).toBeUndefined();
    });

    itAdapted(
      "ADR-004",
      "should omit pipes when not provided in assignMetadata and createParamDecorator",
      () => {
        const result = assignMetadata({}, "b", 1);
        expect(result["b:1"]?.pipes).toBeUndefined();

        const CustomDec = createParamDecorator(factory);
        class TestController {
          handler(_a: unknown, @CustomDec() _b: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(
          TestController,
          "handler",
        );
        expect(params[0]?.pipes).toBeUndefined();
      },
    );

    it("should accept a numeric paramtype", () => {
      const result = assignMetadata({}, 123, 0);
      expect(result).toHaveProperty("123:0");
    });
  },
);
