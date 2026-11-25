import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  Logger,
  MetadataRegistry,
} from "../../../../../../packages/core/src/common";
import {
  ApiTags,
  SWAGGER_METADATA_KEYS,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ApiTags",
  {
    upstreamPath: "test/decorators/api-use-tags.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores @ApiTags names under SWAGGER_METADATA_KEYS.API_TAGS via MetadataRegistry (ADR-002).",
  },
  () => {
    const warnSpy = spyOn(Logger.prototype, "warn").mockImplementation(
      () => {},
    );

    afterAll(() => {
      warnSpy.mockRestore();
    });

    describe("with string arguments (backward compatibility)", () => {
      class TestController {
        @ApiTags("Cats")
        singleTag() {}

        @ApiTags("Cats", "Pets")
        multipleTags() {}
      }

      it("should store single string tag", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          TestController.prototype.singleTag,
        );
        expect(tags).toEqual(["Cats"]);
      });

      it("should store multiple string tags", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          TestController.prototype.multipleTags,
        );
        expect(tags).toEqual(["Cats", "Pets"]);
      });
    });

    describe("with object arguments", () => {
      class TestController {
        @ApiTags({ name: "Cats" })
        objectTag() {}

        @ApiTags({ name: "Cats", parent: "Animals" })
        objectWithParent() {}

        @ApiTags({ name: "Internal", kind: "reference" })
        objectWithKind() {}

        @ApiTags({ name: "Cats", parent: "Animals", kind: "navigation" })
        objectWithBoth() {}
      }

      it("should extract name from object tag", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          TestController.prototype.objectTag,
        );
        expect(tags).toEqual(["Cats"]);
      });

      it("should extract name from object with parent", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          TestController.prototype.objectWithParent,
        );
        expect(tags).toEqual(["Cats"]);
      });

      it("should extract name from object with kind", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          TestController.prototype.objectWithKind,
        );
        expect(tags).toEqual(["Internal"]);
      });

      it("should extract name from object with parent and kind", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          TestController.prototype.objectWithBoth,
        );
        expect(tags).toEqual(["Cats"]);
      });
    });

    describe("with mixed string and object arguments", () => {
      class TestController {
        @ApiTags("Dogs", { name: "Cats" })
        mixed() {}

        @ApiTags({ name: "Cats", parent: "Animals" }, "Dogs", { name: "Birds" })
        complexMixed() {}
      }

      it("should handle mixed string and object tags", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          TestController.prototype.mixed,
        );
        expect(tags).toEqual(["Dogs", "Cats"]);
      });

      it("should handle complex mixed tags", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          TestController.prototype.complexMixed,
        );
        expect(tags).toEqual(["Cats", "Dogs", "Birds"]);
      });
    });

    describe("warns when hierarchy fields are used", () => {
      beforeEach(() => {
        warnSpy.mockClear();
      });

      it("should warn when parent is set on @ApiTags", () => {
        class TestController {
          @ApiTags({ name: "Cats", parent: "Animals" })
          withParent() {}
        }
        void TestController;

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain('"Cats"');
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain("parent/kind");
      });

      it("should warn when kind is set on @ApiTags", () => {
        class TestController {
          @ApiTags({ name: "Internal", kind: "reference" })
          withKind() {}
        }
        void TestController;

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain('"Internal"');
      });

      it("should warn once per object tag carrying hierarchy fields", () => {
        class TestController {
          @ApiTags({ name: "Cats", parent: "Animals" }, "Dogs", {
            name: "Birds",
            kind: "navigation",
          })
          mixed() {}
        }
        void TestController;

        expect(warnSpy).toHaveBeenCalledTimes(2);
      });

      it("should not warn for plain string tags", () => {
        class TestController {
          @ApiTags("Cats", "Pets")
          plain() {}
        }
        void TestController;

        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("should not warn for object tags without hierarchy fields", () => {
        class TestController {
          @ApiTags({ name: "Cats" })
          nameOnly() {}
        }
        void TestController;

        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    describe("applied on class", () => {
      @ApiTags("Cats")
      class StringTagController {}

      @ApiTags({ name: "Dogs", parent: "Animals" })
      class ObjectTagController {}

      @ApiTags("Birds", { name: "Cats", parent: "Animals" })
      class MixedTagController {}

      it("should store string tag on class", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          StringTagController,
        );
        expect(tags).toEqual(["Cats"]);
      });

      it("should store object tag name on class", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          ObjectTagController,
        );
        expect(tags).toEqual(["Dogs"]);
      });

      it("should store mixed tags on class", () => {
        const tags = MetadataRegistry.get(
          SWAGGER_METADATA_KEYS.API_TAGS,
          MixedTagController,
        );
        expect(tags).toEqual(["Birds", "Cats"]);
      });
    });
  },
);
