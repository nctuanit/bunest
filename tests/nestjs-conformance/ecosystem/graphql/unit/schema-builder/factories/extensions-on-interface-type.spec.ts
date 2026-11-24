import { beforeAll, expect, it } from "bun:test";
import type { GraphQLSchema } from "../../../../../../../packages/graphql/src";
import {
  Extensions,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  InterfaceType,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@Extensions({ role: "admin" })
@InterfaceType()
abstract class InternalResource {
  @Field(() => ID)
  id!: string;
}

@Extensions({ role: "admin" })
@ObjectType({ implements: () => [InternalResource] })
class Payslip implements InternalResource {
  id!: string;
}

@Resolver()
class PayslipResolver {
  @Query(() => Payslip)
  payslip(): Payslip {
    return null as unknown as Payslip;
  }
}

describeConformance(
  "@Extensions() on an @InterfaceType() class",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/extensions-on-interface-type.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass]) to Bunest GraphQLSchemaFactory.create([new ResolverClass()]) (ADR-013).",
  },
  () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      schema = await moduleRef
        .get(GraphQLSchemaFactory)
        .create([new PayslipResolver()]);
    });

    it("should add the extensions to the interface type, as for object types", () => {
      expect(schema.getType("Payslip")!.extensions).toEqual({ role: "admin" });
      expect(schema.getType("InternalResource")!.extensions).toEqual({
        role: "admin",
      });
    });
  },
);
