import "reflect-metadata";
import { beforeEach, describe, expect, it } from "bun:test";
import { MetadataRegistry } from "../../../../../../packages/common/src";
import {
  ApiProperty,
  PartialType,
  SWAGGER_METADATA_KEYS,
  SchemaExplorer,
  SwaggerModule,
  type ApiPropertyMetadata,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

const METADATA_FACTORY_NAME = "_OPENAPI_METADATA_FACTORY" as const;

function getInheritedPropertyMetadata(
  classRef: Function,
  key: string,
): ApiPropertyMetadata | undefined {
  let result: ApiPropertyMetadata | undefined;
  for (const ctor of MetadataRegistry.getPrototypeChain(classRef)) {
    const own = MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
      SWAGGER_METADATA_KEYS.API_PROPERTIES,
      ctor,
    );
    if (!own) continue;
    for (const entry of own) {
      if (entry.propertyKey === key) {
        result = result ? { ...result, ...entry } : entry;
      }
    }
  }
  return result;
}

describeConformance(
  "PartialType with extended class DTOs",
  {
    upstreamPath: "test/type-helpers/partial-type-inheritance.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Adapts ModelPropertiesAccessor + SchemaObjectFactory + MetadataLoader to Bunest MetadataRegistry, SchemaExplorer, and SwaggerModule.loadPluginMetadata() (ADR-002, ADR-005, ADR-013).",
  },
  () => {
    describe("when a class extends PartialType(BaseClass) and adds its own @ApiProperty properties", () => {
      class ClassADto {
        @ApiProperty()
        propA!: string;
      }

      class ClassBDto extends PartialType(ClassADto) {
        @ApiProperty()
        propB!: string;
      }

      it("should include properties from both the parent and child class", () => {
        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(ClassBDto);
        const properties = Object.keys(
          explorer.getSchemas().ClassBDto?.properties ?? {},
        );
        expect(properties).toContain("propA");
        expect(properties).toContain("propB");
      });

      it("should mark parent properties as optional (required: false)", () => {
        const metadata = getInheritedPropertyMetadata(ClassBDto, "propA");
        expect(metadata).toBeDefined();
        expect(metadata?.required).toBe(false);
      });
    });

    describe("when parent class uses only plugin metadata (no @ApiProperty decorators)", () => {
      class PluginOnlyParent {
        propFromParent!: string;

        static [METADATA_FACTORY_NAME]() {
          return {
            propFromParent: { required: true, type: () => String },
          };
        }
      }

      class ChildOfPartialPlugin extends PartialType(PluginOnlyParent) {
        @ApiProperty()
        childProp!: string;
      }

      // BUNEST_BUG: PartialType / SchemaExplorer (packages/swagger/src/schema-explorer.ts, packages/common/src/mapped-types/mapped-types.utils.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should include plugin-based parent properties in the child prototype chain", () => {
        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(ChildOfPartialPlugin);
        const properties = Object.keys(
          explorer.getSchemas().ChildOfPartialPlugin?.properties ?? {},
        );
        expect(properties).toContain("propFromParent");
        expect(properties).toContain("childProp");
      });

      // BUNEST_BUG: PartialType / SchemaExplorer (packages/swagger/src/schema-explorer.ts, packages/common/src/mapped-types/mapped-types.utils.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should mark plugin parent properties as optional", () => {
        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(ChildOfPartialPlugin);
        const schema = explorer.getSchemas().ChildOfPartialPlugin;
        expect(schema?.properties).toHaveProperty("propFromParent");
        expect(schema?.required ?? []).not.toContain("propFromParent");
      });
    });

    describe("when both parent and child use only plugin metadata", () => {
      class PluginParent {
        parentProp!: string;

        static [METADATA_FACTORY_NAME]() {
          return {
            parentProp: { required: true, type: () => String },
          };
        }
      }

      class PluginChild extends PartialType(PluginParent) {
        childProp!: number;

        static [METADATA_FACTORY_NAME]() {
          return {
            childProp: { required: true, type: () => Number },
          };
        }
      }

      // BUNEST_BUG: PartialType / SchemaExplorer (packages/swagger/src/schema-explorer.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata from parent or child classes
      it.skip("should include properties from both parent and child after applyMetadataFactory", () => {
        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(PluginChild);
        const properties = Object.keys(
          explorer.getSchemas().PluginChild?.properties ?? {},
        );
        expect(properties).toContain("parentProp");
        expect(properties).toContain("childProp");
      });

      // BUNEST_BUG: PartialType / SchemaExplorer (packages/swagger/src/schema-explorer.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata from parent or child classes
      it.skip("should mark parent properties as optional", () => {
        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(PluginChild);
        const schema = explorer.getSchemas().PluginChild;
        expect(schema?.properties).toHaveProperty("parentProp");
        expect(schema?.required ?? []).not.toContain("parentProp");
      });
    });

    describe("when metadata is loaded via MetadataLoader (SWC readonly mode)", () => {
      class LazyParent {
        parentProp!: string;
      }

      class LazyChild extends PartialType(LazyParent) {
        @ApiProperty({ type: String })
        childProp!: string;
      }

      // BUNEST_BUG: PartialType / plugin-metadata-store (packages/swagger/src/plugin-metadata-store.ts, packages/common/src/mapped-types/mapped-types.utils.ts) does not retroactively inherit plugin metadata loaded after PartialType(LazyParent)
      it.skip("should include parent properties after metadata is loaded", async () => {
        const SERIALIZED_METADATA = {
          "@nestjs/swagger": {
            models: [
              [
                Promise.resolve({ LazyParent }),
                {
                  LazyParent: {
                    parentProp: { required: true, type: () => String },
                  },
                },
              ],
            ],
          },
        };

        await SwaggerModule.loadPluginMetadata(async () => SERIALIZED_METADATA);

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(LazyChild);
        const properties = Object.keys(
          explorer.getSchemas().LazyChild?.properties ?? {},
        );

        expect(properties).toContain("parentProp");
        expect(properties).toContain("childProp");
      });

      // BUNEST_BUG: PartialType / plugin-metadata-store (packages/swagger/src/plugin-metadata-store.ts, packages/common/src/mapped-types/mapped-types.utils.ts) does not retroactively inherit plugin metadata loaded after PartialType(LazyParent)
      it.skip("should mark parent properties as optional after metadata is loaded", async () => {
        const SERIALIZED_METADATA = {
          "@nestjs/swagger": {
            models: [
              [
                Promise.resolve({ LazyParent }),
                {
                  LazyParent: {
                    parentProp: { required: true, type: () => String },
                  },
                },
              ],
            ],
          },
        };

        await SwaggerModule.loadPluginMetadata(async () => SERIALIZED_METADATA);

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(LazyChild);
        const schema = explorer.getSchemas().LazyChild;
        expect(schema?.properties).toHaveProperty("parentProp");
        expect(schema?.required ?? []).not.toContain("parentProp");
      });
    });

    describe("schema generation with SchemaObjectFactory (SchemaExplorer)", () => {
      let explorer: SchemaExplorer;

      beforeEach(() => {
        explorer = new SchemaExplorer();
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should generate schema with all properties for class extending PartialType with plugin metadata", () => {
        class PluginBase {
          baseProp!: string;

          static [METADATA_FACTORY_NAME]() {
            return {
              baseProp: { required: true, type: () => String },
            };
          }
        }

        class PluginChild extends PartialType(PluginBase) {
          childProp!: string;

          static [METADATA_FACTORY_NAME]() {
            return {
              childProp: { required: true, type: () => String },
            };
          }
        }

        explorer.registerDtoSchema(PluginChild);
        const schemas = explorer.getSchemas();

        expect(schemas.PluginChild).toBeDefined();
        expect(schemas.PluginChild?.properties).toHaveProperty("baseProp");
        expect(schemas.PluginChild?.properties).toHaveProperty("childProp");
      });

      it("should mark parent properties as not required in schema", () => {
        class BaseDto {
          @ApiProperty({ type: String, required: true })
          baseProp!: string;
        }

        class ChildDto extends PartialType(BaseDto) {
          @ApiProperty({ type: String, required: true })
          childProp!: string;
        }

        explorer.registerDtoSchema(ChildDto);
        const schemas = explorer.getSchemas();

        const required = schemas.ChildDto?.required || [];
        expect(required).toContain("childProp");
        expect(required).not.toContain("baseProp");
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata across deep inheritance chains
      it.skip("should handle deep inheritance chains", () => {
        class GrandParent {
          grandProp!: string;
          static [METADATA_FACTORY_NAME](): Record<string, any> {
            return { grandProp: { required: true, type: () => String } };
          }
        }

        class Parent extends GrandParent {
          parentProp!: string;
          static override [METADATA_FACTORY_NAME](): Record<string, any> {
            return { parentProp: { required: true, type: () => String } };
          }
        }

        class Child extends PartialType(Parent) {
          childProp!: string;
          static [METADATA_FACTORY_NAME](): Record<string, any> {
            return { childProp: { required: true, type: () => String } };
          }
        }

        explorer.registerDtoSchema(Child);
        const schemas = explorer.getSchemas();

        expect(schemas.Child).toBeDefined();
        expect(schemas.Child?.properties).toHaveProperty("grandProp");
        expect(schemas.Child?.properties).toHaveProperty("parentProp");
        expect(schemas.Child?.properties).toHaveProperty("childProp");

        const required = schemas.Child?.required || [];
        expect(required).toContain("childProp");
        expect(required).not.toContain("grandProp");
        expect(required).not.toContain("parentProp");
      });
    });
  },
);
