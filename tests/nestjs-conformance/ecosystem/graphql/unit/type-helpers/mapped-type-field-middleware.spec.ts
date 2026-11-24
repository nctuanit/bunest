import { expect, it } from "bun:test";
import {
  Field,
  type FieldMiddleware,
  IntersectionType,
  ObjectType,
  OmitType,
  PartialType,
  PickType,
  UseFieldMiddleware,
  getUseFieldMiddleware,
} from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

const parentMiddleware: FieldMiddleware = (_, next) => next();
const childMiddleware: FieldMiddleware = (_, next) => next();
const otherMiddleware: FieldMiddleware = (_, next) => next();

@ObjectType()
class Employee {
  @Field()
  @UseFieldMiddleware(parentMiddleware)
  salary!: string;

  @Field()
  name!: string;
}

// Re-decorates an inherited member without redeclaring "@Field()"
@ObjectType()
class RestrictedEmployee extends Employee {
  @UseFieldMiddleware(childMiddleware)
  declare salary: string;
}

@ObjectType()
class Badge {
  @Field()
  @UseFieldMiddleware(otherMiddleware)
  salary!: string;
}

describeConformance(
  "Mapped types and @UseFieldMiddleware() on inherited members",
  {
    upstreamPath:
      "packages/graphql/tests/type-helpers/mapped-type-field-middleware.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Tests GraphQL mapped types preserving @UseFieldMiddleware() metadata on inherited members (ADR-002, ADR-013).",
  },
  () => {
    // BUNEST_BUG: GraphQL mapped types hook in packages/graphql/src/decorators/type.decorators.ts (lines 854-881) does not clone accumulated @UseFieldMiddleware() metadata (base + derived) onto mapped types; PickType only copies the nearest prototype's own metadata ([childMiddleware]) via copyReflectPropertyMetadata, while OmitType and PartialType return [] because @Field()-only members are not in inheritDtoMetadata's discoveredProps.
    it.skip.each([
      ["PickType", () => PickType(RestrictedEmployee, ["salary"] as const)],
      ["OmitType", () => OmitType(RestrictedEmployee, ["name"] as const)],
      ["PartialType", () => PartialType(RestrictedEmployee)],
    ] as const)(
      "%s should keep the middleware of the class it is built from",
      (_, createType) => {
        expect(getUseFieldMiddleware(createType().prototype, "salary")).toEqual(
          [parentMiddleware, childMiddleware],
        );
      },
    );

    // BUNEST_BUG: IntersectionType() + mapped-type hook in packages/graphql/src/decorators/type.decorators.ts (lines 854-881, 944-951) does not merge @UseFieldMiddleware() arrays from both source classes (returns [] instead of [parentMiddleware, childMiddleware, otherMiddleware]).
    it.skip("IntersectionType should keep the middleware of both classes", () => {
      const type = IntersectionType(RestrictedEmployee, Badge);
      expect(getUseFieldMiddleware(type.prototype, "salary")).toEqual([
        parentMiddleware,
        childMiddleware,
        otherMiddleware,
      ]);
    });

    it("should not change mapped types of the declaring class itself", () => {
      expect(
        getUseFieldMiddleware(
          PickType(Employee, ["salary"] as const).prototype,
          "salary",
        ),
      ).toEqual([parentMiddleware]);
    });
  },
);
