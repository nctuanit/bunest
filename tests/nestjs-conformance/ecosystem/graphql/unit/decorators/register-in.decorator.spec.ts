import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ArgsType,
  Field,
  InputType,
  InterfaceType,
  ObjectType,
  TypeMetadataStorage,
  createUnionType,
  registerEnumType,
} from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

// Mock modules
class AppModule {}
class FeatureModule {}

describeConformance(
  "registerIn decorator option",
  {
    upstreamPath:
      "packages/graphql/tests/decorators/register-in.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest registers GraphQL type metadata eagerly into TypeMetadataStorage without NestJS internal LazyMetadataStorage.",
  },
  () => {
    afterEach(() => {
      TypeMetadataStorage.clear();
    });

    describe("@ObjectType decorator", () => {
      it("should store registerIn as arrow function", () => {
        @ObjectType({ registerIn: () => FeatureModule })
        class TestType {
          @Field(() => String)
          name!: string;
        }

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getObjectTypeMetadataByTarget(TestType);
        expect(metadata).toBeDefined();
        expect(metadata!.registerIn).toBeDefined();

        // Arrow function should be stored
        expect(typeof metadata!.registerIn).toBe("function");

        // When called, it should return the module
        const resolvedModule = (metadata!.registerIn as () => Function)();
        expect(resolvedModule).toBe(FeatureModule);
      });

      it("should store registerIn as direct module reference", () => {
        @ObjectType({ registerIn: AppModule })
        class TestType {
          @Field(() => String)
          name!: string;
        }

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getObjectTypeMetadataByTarget(TestType);
        expect(metadata).toBeDefined();
        expect(metadata!.registerIn).toBe(AppModule);
      });

      it("should work without registerIn option (included in all schemas)", () => {
        @ObjectType()
        class TestType {
          @Field(() => String)
          name!: string;
        }

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getObjectTypeMetadataByTarget(TestType);
        expect(metadata).toBeDefined();
        expect(metadata!.registerIn).toBeUndefined();
      });

      it("should work with name and registerIn option", () => {
        @ObjectType("CustomName", { registerIn: () => FeatureModule })
        class TestType {
          @Field(() => String)
          name!: string;
        }

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getObjectTypeMetadataByTarget(TestType);
        expect(metadata).toBeDefined();
        expect(metadata!.name).toBe("CustomName");
        expect((metadata!.registerIn as () => Function)()).toBe(FeatureModule);
      });
    });

    describe("@InputType decorator", () => {
      it("should store registerIn option", () => {
        @InputType({ registerIn: () => FeatureModule })
        class TestInput {
          @Field(() => String)
          name!: string;
        }

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getInputTypeMetadataByTarget(TestInput);
        expect(metadata).toBeDefined();
        expect((metadata!.registerIn as () => Function)()).toBe(FeatureModule);
      });

      it("should work with name and registerIn option", () => {
        @InputType("CustomInput", { registerIn: () => AppModule })
        class TestInput {
          @Field(() => String)
          value!: string;
        }

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getInputTypeMetadataByTarget(TestInput);
        expect(metadata).toBeDefined();
        expect(metadata!.name).toBe("CustomInput");
        expect((metadata!.registerIn as () => Function)()).toBe(AppModule);
      });
    });

    describe("@InterfaceType decorator", () => {
      it("should store registerIn option", () => {
        @InterfaceType({ registerIn: () => FeatureModule })
        abstract class TestInterface {
          @Field(() => String)
          id!: string;
        }

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getInterfaceMetadataByTarget(TestInterface);
        expect(metadata).toBeDefined();
        expect((metadata!.registerIn as () => Function)()).toBe(FeatureModule);
      });
    });

    describe("@ArgsType decorator", () => {
      it("should store registerIn option", () => {
        @ArgsType({ registerIn: () => AppModule })
        class TestArgs {
          @Field(() => String)
          query!: string;
        }

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getArgumentsMetadataByTarget(TestArgs);
        expect(metadata).toBeDefined();
        expect((metadata!.registerIn as () => Function)()).toBe(AppModule);
      });

      it("should work with name and registerIn option", () => {
        @ArgsType("CustomArgs", { registerIn: () => FeatureModule })
        class TestArgs {
          @Field(() => String)
          query!: string;
        }

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getArgumentsMetadataByTarget(TestArgs);
        expect(metadata).toBeDefined();
        expect(metadata!.name).toBe("CustomArgs");
        expect((metadata!.registerIn as () => Function)()).toBe(FeatureModule);
      });
    });

    describe("registerEnumType function", () => {
      it("should store registerIn option", () => {
        enum TestStatus {
          ACTIVE = "ACTIVE",
          INACTIVE = "INACTIVE",
        }

        registerEnumType(TestStatus, {
          name: "TestStatus",
          registerIn: () => FeatureModule,
        });

        TypeMetadataStorage.compile();

        const allEnums = TypeMetadataStorage.getEnumsMetadata();
        const metadata = allEnums.find((e) => e.name === "TestStatus");

        expect(metadata).toBeDefined();
        expect((metadata!.registerIn as () => Function)()).toBe(FeatureModule);
      });

      it("should work with direct module reference", () => {
        enum DirectRefStatus {
          YES = "YES",
          NO = "NO",
        }

        registerEnumType(DirectRefStatus, {
          name: "DirectRefStatus",
          registerIn: AppModule,
        });

        TypeMetadataStorage.compile();

        const allEnums = TypeMetadataStorage.getEnumsMetadata();
        const metadata = allEnums.find((e) => e.name === "DirectRefStatus");

        expect(metadata).toBeDefined();
        expect(metadata!.registerIn).toBe(AppModule);
      });
    });

    describe("createUnionType function", () => {
      it("should store registerIn option", () => {
        @ObjectType()
        class UnionMemberA {
          @Field(() => String)
          a!: string;
        }

        @ObjectType()
        class UnionMemberB {
          @Field(() => String)
          b!: string;
        }

        const TestUnion = createUnionType({
          name: "TestUnion",
          types: () => [UnionMemberA, UnionMemberB] as const,
          registerIn: () => FeatureModule,
        });
        void TestUnion;

        TypeMetadataStorage.compile();

        const allUnions = TypeMetadataStorage.getUnionsMetadata();
        const metadata = allUnions.find((u) => u.name === "TestUnion");

        expect(metadata).toBeDefined();
        expect((metadata!.registerIn as () => Function)()).toBe(FeatureModule);
      });
    });

    describe("circular dependency handling", () => {
      it("should handle deferred module resolution via arrow function", () => {
        // Simulate circular dependency scenario where module is not yet defined
        let DeferredModule: any;

        @ObjectType({ registerIn: () => DeferredModule })
        class DeferredType {
          @Field(() => String)
          name!: string;
        }

        // Define module after decorator is applied
        DeferredModule = class DeferredModuleClass {};

        TypeMetadataStorage.compile();

        const metadata =
          TypeMetadataStorage.getObjectTypeMetadataByTarget(DeferredType);
        expect(metadata).toBeDefined();

        // Arrow function should correctly resolve the module
        const resolvedModule = (metadata!.registerIn as () => Function)();
        expect(resolvedModule).toBe(DeferredModule);
      });
    });
  },
);
