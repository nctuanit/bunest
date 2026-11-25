import { describe, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Get,
  MetadataRegistry,
  Module,
  Post,
  type Type,
} from "../../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../../packages/core/src";
import {
  ApiExtension,
  DocumentBuilder,
  SWAGGER_METADATA_KEYS,
  SwaggerModule,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

interface StoredExtensionEntry {
  readonly key: string;
  readonly value: unknown;
}

function getExtensionsRecord(
  target: object,
): Record<string, unknown> | undefined {
  const entries = MetadataRegistry.get<readonly StoredExtensionEntry[]>(
    SWAGGER_METADATA_KEYS.API_EXTENSIONS,
    target,
  );
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    out[entry.key] = entry.value;
  }
  return out;
}

async function getOperationExtensions(
  controller: Type<unknown>,
  path: string,
  method: "get" | "post",
): Promise<Record<string, unknown>> {
  @Module({ controllers: [controller] })
  class TestModule {}
  const app = await BunestFactory.create(TestModule, { logger: false });
  try {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const op = doc.paths[path]?.[method] as Record<string, unknown> | undefined;
    const out: Record<string, unknown> = {};
    if (op) {
      for (const [k, v] of Object.entries(op)) {
        if (k.startsWith("x-")) {
          out[k] = v;
        }
      }
    }
    return out;
  } finally {
    await app.close();
  }
}

describeConformance(
  "ApiExtension",
  {
    upstreamPath: "test/decorators/api-extension.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores @ApiExtension entries via MetadataRegistry (SWAGGER_METADATA_KEYS.API_EXTENSIONS) on class/method targets without mutating prototype methods at decoration time (ADR-002), and merges them during SwaggerModule.createDocument().",
  },
  () => {
    describe("when applied on the class level", () => {
      @ApiExtension("x-controller-extension", { test: "value" })
      @Controller("test")
      class TestAppController {
        @Get()
        public get(): string {
          return "test";
        }

        @Post()
        public post(@Body() _body: any): string {
          return "created";
        }

        public noApiMethod(): void {}
      }

      it("should attach metadata to all API methods", async () => {
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_EXTENSIONS,
            TestAppController,
          ),
        ).toBe(true);
        expect(
          await getOperationExtensions(TestAppController, "/test", "get"),
        ).toEqual({ "x-controller-extension": { test: "value" } });
        expect(
          await getOperationExtensions(TestAppController, "/test", "post"),
        ).toEqual({ "x-controller-extension": { test: "value" } });
      });

      it("should not attach metadata to non-API method (not a route)", () => {
        const controller = new TestAppController();
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_EXTENSIONS,
            controller.noApiMethod,
          ),
        ).toBe(false);
      });
    });

    describe("when applied on the method level", () => {
      @Controller("test")
      class TestAppController {
        @Get()
        @ApiExtension("x-method-extension", { method: "specific" })
        public get(): string {
          return "test";
        }

        @Post()
        public post(@Body() _body: any): string {
          return "created";
        }
      }

      it("should attach metadata to a given method", () => {
        const controller = new TestAppController();
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_EXTENSIONS,
            controller.get,
          ),
        ).toBe(true);
        expect(getExtensionsRecord(controller.get)).toEqual({
          "x-method-extension": { method: "specific" },
        });
      });

      it("should not attach metadata to methods without the decorator", () => {
        const controller = new TestAppController();
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_EXTENSIONS,
            controller.post,
          ),
        ).toBe(false);
      });
    });

    describe("when applied multiple times", () => {
      @Controller("test")
      class TestAppController {
        @Get()
        @ApiExtension("x-first-extension", { first: "value" })
        @ApiExtension("x-second-extension", { second: "value" })
        public get(): string {
          return "test";
        }
      }

      it("should merge multiple extensions", () => {
        const controller = new TestAppController();
        expect(getExtensionsRecord(controller.get)).toEqual({
          "x-first-extension": { first: "value" },
          "x-second-extension": { second: "value" },
        });
      });
    });

    describe("when combining extensions from class and method level", () => {
      @ApiExtension("x-class-extension", { class: "level" })
      @Controller("test")
      class TestAppController {
        @Get()
        @ApiExtension("x-method-extension", { method: "level" })
        public get(): string {
          return "test";
        }

        @Post()
        public post(@Body() _body: any): string {
          return "created";
        }
      }

      it("should merge class and method level extensions", async () => {
        expect(
          await getOperationExtensions(TestAppController, "/test", "get"),
        ).toEqual({
          "x-class-extension": { class: "level" },
          "x-method-extension": { method: "level" },
        });
      });

      it("should apply only class level extension to methods without method decorator", async () => {
        expect(
          await getOperationExtensions(TestAppController, "/test", "post"),
        ).toEqual({
          "x-class-extension": { class: "level" },
        });
      });
    });

    describe("when combining class and method level values", () => {
      @ApiExtension("x-extension", { class: "level" })
      @Controller("test")
      class TestAppController {
        @Get()
        @ApiExtension("x-extension", { method: "level" })
        public get(): string {
          return "test";
        }

        @Post()
        public post(@Body() _body: any): string {
          return "created";
        }
      }

      it("should override class level extension with method level extension (no merging)", async () => {
        expect(
          await getOperationExtensions(TestAppController, "/test", "get"),
        ).toEqual({
          "x-extension": { method: "level" },
        });
      });

      it("should apply only class level extension to methods without method decorator", async () => {
        expect(
          await getOperationExtensions(TestAppController, "/test", "post"),
        ).toEqual({
          "x-extension": { class: "level" },
        });
      });
    });

    describe("extension key validation", () => {
      it('should throw an error if extension key does not start with "x-"', () => {
        expect(() => {
          @ApiExtension("invalid-key", { test: "value" })
          @Controller("test")
          class TestController {
            @Get()
            public get(): string {
              return "test";
            }
          }
          return TestController;
        }).toThrow(/not prefixed.*x-/i);
      });

      it('should accept extension key that starts with "x-"', () => {
        expect(() => {
          @ApiExtension("x-valid-key", { test: "value" })
          @Controller("test")
          class TestController {
            @Get()
            public get(): string {
              return "test";
            }
          }
          return TestController;
        }).not.toThrow();
      });
    });

    describe("extension properties cloning", () => {
      it("should shallow clone extension properties (top-level properties are cloned)", () => {
        const originalProperties = {
          topLevel: "original",
          nested: { value: "original" },
        };

        @Controller("test")
        class TestAppController {
          @Get()
          @ApiExtension("x-clone-test", originalProperties)
          public get(): string {
            return "test";
          }
        }

        const controller = new TestAppController();
        const metadata = getExtensionsRecord(controller.get) as Record<
          string,
          { topLevel: string; nested: { value: string } }
        >;

        metadata["x-clone-test"]!.topLevel = "modified";
        expect(originalProperties.topLevel).toBe("original");

        metadata["x-clone-test"]!.nested.value = "modified";
        expect(originalProperties.nested.value).toBe("modified");
      });

      it("should clone extension properties when applied to multiple methods", () => {
        const sharedProperties = { counter: 0 };

        @Controller("test")
        class TestAppController {
          @Get("first")
          @ApiExtension("x-shared", sharedProperties)
          public getFirst(): string {
            return "first";
          }

          @Get("second")
          @ApiExtension("x-shared", sharedProperties)
          public getSecond(): string {
            return "second";
          }
        }

        const controller = new TestAppController();
        const firstMetadata = getExtensionsRecord(
          controller.getFirst,
        ) as Record<string, { counter: number }>;
        const secondMetadata = getExtensionsRecord(
          controller.getSecond,
        ) as Record<string, { counter: number }>;

        firstMetadata["x-shared"]!.counter = 1;

        expect(secondMetadata["x-shared"]!.counter).toBe(0);
        expect(sharedProperties.counter).toBe(0);
      });
    });

    describe("edge cases", () => {
      it("should handle empty extension properties", () => {
        @Controller("test")
        class TestAppController {
          @Get()
          @ApiExtension("x-empty", {})
          public get(): string {
            return "test";
          }
        }

        const controller = new TestAppController();
        expect(getExtensionsRecord(controller.get)).toEqual({ "x-empty": {} });
      });

      it("should handle null extension properties", () => {
        @Controller("test")
        class TestAppController {
          @Get()
          @ApiExtension("x-null", null)
          public get(): string {
            return "test";
          }
        }

        const controller = new TestAppController();
        expect(getExtensionsRecord(controller.get)).toEqual({ "x-null": null });
      });

      it("should handle array extension properties", () => {
        @Controller("test")
        class TestAppController {
          @Get()
          @ApiExtension("x-array", ["item1", "item2"])
          public get(): string {
            return "test";
          }
        }

        const controller = new TestAppController();
        expect(getExtensionsRecord(controller.get)).toEqual({
          "x-array": ["item1", "item2"],
        });
      });

      it("should handle primitive extension properties", () => {
        @Controller("test")
        class TestAppController {
          @Get()
          @ApiExtension("x-string", "simple string")
          public getString(): string {
            return "test";
          }

          @Post()
          @ApiExtension("x-number", 42)
          public getNumber(): string {
            return "test";
          }
        }

        const controller = new TestAppController();
        expect(getExtensionsRecord(controller.getString)).toEqual({
          "x-string": "simple string",
        });
        expect(getExtensionsRecord(controller.getNumber)).toEqual({
          "x-number": 42,
        });
      });

      it("should work with controllers that have no API methods", () => {
        expect(() => {
          @ApiExtension("x-no-api-methods", { test: "value" })
          @Controller("test")
          class TestAppController {
            public regularMethod(): void {}
            public helperMethod(): void {}
          }
          return TestAppController;
        }).not.toThrow();
      });
    });

    describe("when applied to non-controller classes (DTOs/schemas)", () => {
      it("should attach metadata to the class itself", () => {
        @ApiExtension("x-schema-extension", { schema: "metadata" })
        class TestDto {
          name!: string;
          age!: number;
        }

        expect(
          MetadataRegistry.has(SWAGGER_METADATA_KEYS.API_EXTENSIONS, TestDto),
        ).toBe(true);
        expect(getExtensionsRecord(TestDto)).toEqual({
          "x-schema-extension": { schema: "metadata" },
        });
      });

      it("should merge multiple extensions on the same class", () => {
        @ApiExtension("x-first-schema", { first: "value" })
        @ApiExtension("x-second-schema", { second: "value" })
        class TestDto {
          name!: string;
        }

        expect(getExtensionsRecord(TestDto)).toEqual({
          "x-first-schema": { first: "value" },
          "x-second-schema": { second: "value" },
        });
      });
    });
  },
);
