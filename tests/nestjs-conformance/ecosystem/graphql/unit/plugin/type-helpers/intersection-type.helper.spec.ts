import { expect, it } from "bun:test";
import {
  Directive,
  Extensions,
  Field,
  IntersectionType,
  ObjectType,
  getFieldsAndDecoratorForType,
} from "../../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../../_helpers/index";

describeConformance(
  "IntersectionType",
  {
    upstreamPath:
      "packages/graphql/tests/plugin/type-helpers/intersection-type.helper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Adapts out SWC METADATA_FACTORY_NAME static method in favor of explicit @Field({ nullable: true }) decorator (ADR-002).",
  },
  () => {
    @ObjectType()
    class ClassA {
      @Field({ nullable: true })
      @Directive("@upper")
      @Extensions({ extension: true })
      login!: string;

      @Field()
      password!: string;
    }

    @ObjectType()
    class ClassB {
      @Field()
      @Directive("@upper")
      @Extensions({ extension: true })
      lastName!: string;

      @Field(() => String, { nullable: true })
      firstName?: string;

      @Field(() => [String])
      hobbies?: string[];
    }

    class UpdateUserDto extends IntersectionType(ClassA, ClassB) {}

    it("should inherit all fields from two types", () => {
      const prototype = Object.getPrototypeOf(UpdateUserDto);
      const { fields } = getFieldsAndDecoratorForType(prototype);
      const loginField = fields.find((f) => f.name === "login");
      const passwordField = fields.find((f) => f.name === "password");
      const lastNameField = fields.find((f) => f.name === "lastName");
      const hobbiesField = fields.find((f) => f.name === "hobbies");
      const firstNameField = fields.find((f) => f.name === "firstName");

      expect(fields.length).toEqual(5);
      expect(loginField?.name).toEqual("login");
      expect(passwordField?.name).toEqual("password");
      expect(lastNameField?.name).toEqual("lastName");
      expect(hobbiesField?.name).toEqual("hobbies");
      expect(hobbiesField?.options).toEqual({ isArray: true, arrayDepth: 1 });
      expect(firstNameField?.name).toEqual("firstName");
      expect(loginField?.directives?.length).toEqual(1);
      expect(loginField?.directives as unknown[]).toContainEqual({
        fieldName: "login",
        sdl: "@upper",
        target: prototype,
      });
      expect(loginField?.extensions).toEqual({
        extension: true,
      });
      expect(lastNameField?.directives?.length).toEqual(1);
      expect(lastNameField?.directives as unknown[]).toContainEqual({
        fieldName: "lastName",
        sdl: "@upper",
        target: prototype,
      });
      expect(lastNameField?.extensions).toEqual({
        extension: true,
      });
    });
  },
);
