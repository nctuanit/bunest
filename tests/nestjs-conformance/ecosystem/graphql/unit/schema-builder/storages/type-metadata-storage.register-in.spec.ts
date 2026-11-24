import { beforeAll, describe, expect, it } from "bun:test";
import {
  ArgsType,
  Field,
  InputType,
  InterfaceType,
  ObjectType,
  TypeMetadataStorage,
  createUnionType,
  registerEnumType,
} from "../../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../../_helpers/index";

// Mock modules for testing
class ModuleA {}
class ModuleB {}
class ModuleC {}

// Test enums
enum StatusEnumA {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
}

enum StatusEnumB {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
}

enum StatusEnumGlobal {
  YES = "YES",
  NO = "NO",
}

describeConformance(
  "TypeMetadataStorage registerIn filtering",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/storages/type-metadata-storage.register-in.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts upstream LazyMetadataStorage.load() to @bunest/graphql eager decorator registration into TypeMetadataStorage (ADR-013).",
  },
  () => {
    let ObjectTypeInModuleA: Function;
    let ObjectTypeInModuleB: Function;
    let ObjectTypeInModuleADirect: Function;
    let ObjectTypeGlobal: Function;
    let InputTypeInModuleA: Function;
    let InputTypeInModuleB: Function;
    let InputTypeGlobal: Function;
    let InterfaceTypeInModuleA: Function;
    let InterfaceTypeInModuleB: Function;
    let InterfaceTypeGlobal: Function;
    let ArgsTypeInModuleA: Function;
    let ArgsTypeInModuleB: Function;
    let ArgsTypeGlobal: Function;

    beforeAll(() => {
      @ObjectType({ registerIn: () => ModuleA })
      class ObjA {
        @Field(() => String)
        name!: string;
      }

      @ObjectType({ registerIn: () => ModuleB })
      class ObjB {
        @Field(() => String)
        name!: string;
      }

      @ObjectType({ registerIn: ModuleA }) // Direct reference (not arrow function)
      class ObjADirect {
        @Field(() => String)
        name!: string;
      }

      @ObjectType() // No registerIn - should be included everywhere
      class ObjGlobal {
        @Field(() => String)
        name!: string;
      }

      @InputType({ registerIn: () => ModuleA })
      class InpA {
        @Field(() => String)
        name!: string;
      }

      @InputType({ registerIn: () => ModuleB })
      class InpB {
        @Field(() => String)
        name!: string;
      }

      @InputType()
      class InpGlobal {
        @Field(() => String)
        name!: string;
      }

      @InterfaceType({ registerIn: () => ModuleA })
      abstract class IfaceA {
        @Field(() => String)
        name!: string;
      }

      @InterfaceType({ registerIn: () => ModuleB })
      abstract class IfaceB {
        @Field(() => String)
        name!: string;
      }

      @InterfaceType()
      abstract class IfaceGlobal {
        @Field(() => String)
        name!: string;
      }

      @ArgsType({ registerIn: () => ModuleA })
      class ArgsA {
        @Field(() => String)
        name!: string;
      }

      @ArgsType({ registerIn: () => ModuleB })
      class ArgsB {
        @Field(() => String)
        name!: string;
      }

      @ArgsType()
      class ArgsGlobal {
        @Field(() => String)
        name!: string;
      }

      ObjectTypeInModuleA = ObjA;
      ObjectTypeInModuleB = ObjB;
      ObjectTypeInModuleADirect = ObjADirect;
      ObjectTypeGlobal = ObjGlobal;
      InputTypeInModuleA = InpA;
      InputTypeInModuleB = InpB;
      InputTypeGlobal = InpGlobal;
      InterfaceTypeInModuleA = IfaceA;
      InterfaceTypeInModuleB = IfaceB;
      InterfaceTypeGlobal = IfaceGlobal;
      ArgsTypeInModuleA = ArgsA;
      ArgsTypeInModuleB = ArgsB;
      ArgsTypeGlobal = ArgsGlobal;

      registerEnumType(StatusEnumA, {
        name: "StatusEnumA",
        registerIn: () => ModuleA,
      });

      registerEnumType(StatusEnumB, {
        name: "StatusEnumB",
        registerIn: () => ModuleB,
      });

      registerEnumType(StatusEnumGlobal, {
        name: "StatusEnumGlobal",
      });

      createUnionType({
        name: "UnionInModuleA",
        types: () => [ObjA, ObjGlobal] as const,
        registerIn: () => ModuleA,
      });

      createUnionType({
        name: "UnionInModuleB",
        types: () => [ObjB, ObjGlobal] as const,
        registerIn: () => ModuleB,
      });

      createUnionType({
        name: "UnionGlobal",
        types: () => [ObjGlobal] as const,
      });

      TypeMetadataStorage.compile();
    });

    describe("getObjectTypesMetadataByModules", () => {
      it("should return types registered in specified module", () => {
        const result = TypeMetadataStorage.getObjectTypesMetadataByModules([
          ModuleA,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(ObjectTypeInModuleA);
        expect(targets).toContain(ObjectTypeInModuleADirect);
        expect(targets).not.toContain(ObjectTypeInModuleB);
      });

      it("should include types with no registerIn (global types)", () => {
        const result = TypeMetadataStorage.getObjectTypesMetadataByModules([
          ModuleA,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(ObjectTypeGlobal);
      });

      it("should handle multiple modules", () => {
        const result = TypeMetadataStorage.getObjectTypesMetadataByModules([
          ModuleA,
          ModuleB,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(ObjectTypeInModuleA);
        expect(targets).toContain(ObjectTypeInModuleB);
        expect(targets).toContain(ObjectTypeGlobal);
      });

      it("should return only global types when module has no registered types", () => {
        const result = TypeMetadataStorage.getObjectTypesMetadataByModules([
          ModuleC,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(ObjectTypeGlobal);
        expect(targets).not.toContain(ObjectTypeInModuleA);
        expect(targets).not.toContain(ObjectTypeInModuleB);
      });

      it("should handle direct module reference (not arrow function)", () => {
        const result = TypeMetadataStorage.getObjectTypesMetadataByModules([
          ModuleA,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(ObjectTypeInModuleADirect);
      });
    });

    describe("getInputTypesMetadataByModules", () => {
      it("should return input types registered in specified module", () => {
        const result = TypeMetadataStorage.getInputTypesMetadataByModules([
          ModuleA,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(InputTypeInModuleA);
        expect(targets).not.toContain(InputTypeInModuleB);
      });

      it("should include input types with no registerIn", () => {
        const result = TypeMetadataStorage.getInputTypesMetadataByModules([
          ModuleB,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(InputTypeGlobal);
        expect(targets).toContain(InputTypeInModuleB);
      });
    });

    describe("getInterfacesMetadataByModules", () => {
      it("should return interface types registered in specified module", () => {
        const result = TypeMetadataStorage.getInterfacesMetadataByModules([
          ModuleA,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(InterfaceTypeInModuleA);
        expect(targets).not.toContain(InterfaceTypeInModuleB);
      });

      it("should include interface types with no registerIn", () => {
        const result = TypeMetadataStorage.getInterfacesMetadataByModules([
          ModuleA,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(InterfaceTypeGlobal);
      });
    });

    describe("getArgumentsMetadataByModules", () => {
      it("should return args types registered in specified module", () => {
        const result = TypeMetadataStorage.getArgumentsMetadataByModules([
          ModuleA,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(ArgsTypeInModuleA);
        expect(targets).not.toContain(ArgsTypeInModuleB);
      });

      it("should include args types with no registerIn", () => {
        const result = TypeMetadataStorage.getArgumentsMetadataByModules([
          ModuleB,
        ]);

        const targets = result.map((m) => m.target);
        expect(targets).toContain(ArgsTypeGlobal);
      });
    });

    describe("getEnumsMetadataByModules", () => {
      it("should return enums registered in specified module", () => {
        const result = TypeMetadataStorage.getEnumsMetadataByModules([ModuleA]);

        const refs = result.map((m) => m.ref);
        expect(refs).toContain(StatusEnumA);
        expect(refs).not.toContain(StatusEnumB);
      });

      it("should include enums with no registerIn", () => {
        const result = TypeMetadataStorage.getEnumsMetadataByModules([ModuleA]);

        const refs = result.map((m) => m.ref);
        expect(refs).toContain(StatusEnumGlobal);
      });

      it("should filter correctly for ModuleB", () => {
        const result = TypeMetadataStorage.getEnumsMetadataByModules([ModuleB]);

        const refs = result.map((m) => m.ref);
        expect(refs).toContain(StatusEnumB);
        expect(refs).toContain(StatusEnumGlobal);
        expect(refs).not.toContain(StatusEnumA);
      });
    });

    describe("getUnionsMetadataByModules", () => {
      it("should return unions registered in specified module", () => {
        const result = TypeMetadataStorage.getUnionsMetadataByModules([
          ModuleA,
        ]);

        const names = result.map((m) => m.name);
        expect(names).toContain("UnionInModuleA");
        expect(names).not.toContain("UnionInModuleB");
      });

      it("should include unions with no registerIn", () => {
        const result = TypeMetadataStorage.getUnionsMetadataByModules([
          ModuleA,
        ]);

        const names = result.map((m) => m.name);
        expect(names).toContain("UnionGlobal");
      });

      it("should filter correctly for ModuleB", () => {
        const result = TypeMetadataStorage.getUnionsMetadataByModules([
          ModuleB,
        ]);

        const names = result.map((m) => m.name);
        expect(names).toContain("UnionInModuleB");
        expect(names).toContain("UnionGlobal");
        expect(names).not.toContain("UnionInModuleA");
      });
    });

    describe("default behavior (all types included when no module filter)", () => {
      it("should return all types when using getObjectTypesMetadata (no module filter)", () => {
        const result = TypeMetadataStorage.getObjectTypesMetadata();

        const targets = result.map((m) => m.target);
        expect(targets).toContain(ObjectTypeInModuleA);
        expect(targets).toContain(ObjectTypeInModuleB);
        expect(targets).toContain(ObjectTypeGlobal);
      });

      it("should return all input types when using getInputTypesMetadata (no module filter)", () => {
        const result = TypeMetadataStorage.getInputTypesMetadata();

        const targets = result.map((m) => m.target);
        expect(targets).toContain(InputTypeInModuleA);
        expect(targets).toContain(InputTypeInModuleB);
        expect(targets).toContain(InputTypeGlobal);
      });

      it("should return all enums when using getEnumsMetadata (no module filter)", () => {
        const result = TypeMetadataStorage.getEnumsMetadata();

        const refs = result.map((m) => m.ref);
        expect(refs).toContain(StatusEnumA);
        expect(refs).toContain(StatusEnumB);
        expect(refs).toContain(StatusEnumGlobal);
      });
    });
  },
);
