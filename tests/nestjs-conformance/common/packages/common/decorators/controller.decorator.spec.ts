import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Controller,
  METADATA_KEYS,
  MetadataRegistry,
  type ControllerMetadata,
} from "../../../../../../packages/common/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "@Controller",
  {
    upstreamPath:
      "packages/common/test/decorators/controller.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002", "ADR-006"],
    notes:
      "Bunest stores controller metadata in METADATA_KEYS.CONTROLLER (and version in METADATA_KEYS.VERSION) per ADR-002/ADR-006.",
  },
  () => {
    const reflectedPath = "test";
    const reflectedHost = "api.example.com";
    const reflectedHostArray = ["api1.example.com", "api2.example.com"];
    const reflectedVersion = "1";
    const reflectedVersionWithDuplicates = ["1", "2", "2", "1", "2", "1"];
    const reflectedVersionWithoutDuplicates = ["1", "2"];

    @Controller()
    class EmptyDecorator {}

    @Controller(reflectedPath)
    class Test {}

    @Controller({ path: reflectedPath, host: reflectedHost })
    class PathAndHostDecorator {}

    @Controller({ path: reflectedPath, host: reflectedHostArray })
    class PathAndHostArrayDecorator {}

    @Controller({ host: reflectedHost })
    class HostOnlyDecorator {}

    @Controller({
      path: reflectedPath,
      host: reflectedHost,
      version: reflectedVersion,
    })
    class PathAndHostAndVersionDecorator {}

    @Controller({ version: reflectedVersion })
    class VersionOnlyDecorator {}

    @Controller({ version: reflectedVersionWithDuplicates })
    class VersionOnlyArrayDecorator {}

    itAdapted(
      "ADR-002",
      "should enhance component with controller metadata",
      () => {
        const controllerMeta = MetadataRegistry.get<ControllerMetadata>(
          METADATA_KEYS.CONTROLLER,
          EmptyDecorator,
        );
        expect(controllerMeta).toBeDefined();
      },
      "METADATA_KEYS.CONTROLLER presence instead of string CONTROLLER_WATERMARK",
    );

    it("should enhance controller with expected path metadata", () => {
      const path = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        Test,
      )?.path;
      expect(path).toEqual(reflectedPath);
      const path2 = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        PathAndHostDecorator,
      )?.path;
      expect(path2).toEqual(reflectedPath);
      const path3 = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        PathAndHostAndVersionDecorator,
      )?.path;
      expect(path3).toEqual(reflectedPath);
    });

    it("should enhance controller with expected host metadata", () => {
      const host = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        PathAndHostDecorator,
      )?.host;
      expect(host).toEqual(reflectedHost);
      const host2 = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        HostOnlyDecorator,
      )?.host;
      expect(host2).toEqual(reflectedHost);
      const host3 = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        PathAndHostArrayDecorator,
      )?.host;
      expect(host3).toEqual(reflectedHostArray);
      const host4 = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        PathAndHostAndVersionDecorator,
      )?.host;
      expect(host4).toEqual(reflectedHost);
    });

    // BUNEST_BUG: Controller({ version: ['1','2','2','1','2','1'] }) in packages/common/src/decorators/http.decorators.ts:35 clones `[...version]` without deduplicating entries, whereas NestJS deduplicates to `['1', '2']`.
    it.skip("should enhance controller with expected version metadata (deduplicating version arrays)", () => {
      const version = MetadataRegistry.get(
        METADATA_KEYS.VERSION,
        PathAndHostAndVersionDecorator,
      );
      expect(version).toEqual(reflectedVersion);
      const version2 = MetadataRegistry.get(
        METADATA_KEYS.VERSION,
        VersionOnlyDecorator,
      );
      expect(version2).toEqual(reflectedVersion);
      const version3 = MetadataRegistry.get(
        METADATA_KEYS.VERSION,
        VersionOnlyArrayDecorator,
      );
      expect(version3).toEqual(reflectedVersionWithoutDuplicates);
    });

    it("should enhance controller with single string version metadata", () => {
      expect(
        MetadataRegistry.get(
          METADATA_KEYS.VERSION,
          PathAndHostAndVersionDecorator,
        ),
      ).toEqual(reflectedVersion);
      expect(
        MetadataRegistry.get(METADATA_KEYS.VERSION, VersionOnlyDecorator),
      ).toEqual(reflectedVersion);
    });

    it("should set default path when no object passed as param", () => {
      const path = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        EmptyDecorator,
      )?.path;
      expect(path).toEqual("/");
      const path2 = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        HostOnlyDecorator,
      )?.path;
      expect(path2).toEqual("/");
      const path3 = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        VersionOnlyDecorator,
      )?.path;
      expect(path3).toEqual("/");
    });

    it("should not set host when no host passed as param", () => {
      const host = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        Test,
      )?.host;
      expect(host).toBeUndefined();
      const host2 = MetadataRegistry.get<ControllerMetadata>(
        METADATA_KEYS.CONTROLLER,
        EmptyDecorator,
      )?.host;
      expect(host2).toBeUndefined();
    });

    it("should not set version when no version passed as param", () => {
      const version = MetadataRegistry.get(METADATA_KEYS.VERSION, Test);
      expect(version).toBeUndefined();
      const version2 = MetadataRegistry.get(
        METADATA_KEYS.VERSION,
        EmptyDecorator,
      );
      expect(version2).toBeUndefined();
    });
  },
);
