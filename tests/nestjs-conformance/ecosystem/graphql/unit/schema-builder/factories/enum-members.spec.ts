import { beforeAll, expect, it } from "bun:test";
import type {
  GraphQLEnumType,
  GraphQLSchema,
} from "../../../../../../../packages/graphql/src";
import {
  Args,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  Query,
  Resolver,
  registerEnumType,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

enum PageSize {
  SMALL = 10,
  LARGE = 100,
  ALL = Infinity,
  UNSET = NaN,
}
registerEnumType(PageSize, { name: "PageSize" });

enum OrderStatus {
  PENDING = "PENDING",
  SHIPPED = "SHIPPED",
}
namespace OrderStatus {
  export function isFinal(status: OrderStatus) {
    return status === OrderStatus.SHIPPED;
  }
  export const ALL: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.SHIPPED];
  export const LABELS = { PENDING: "Pending" };
}
registerEnumType(OrderStatus as unknown as Record<string, string | number>, {
  name: "OrderStatus",
});

@Resolver()
class OrdersResolver {
  @Query(() => String)
  orders(
    @Args("pageSize", { type: () => PageSize, defaultValue: "ALL" })
    _pageSize: PageSize,
    @Args("status", {
      type: () => OrderStatus as unknown as Record<string, string | number>,
    })
    _status: OrderStatus,
  ): string {
    return "ok";
  }
}

describeConformance(
  "Enum members",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/enum-members.spec.ts",
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
        .create([new OrdersResolver()]);
    });

    const getValues = (name: string) =>
      (schema.getType(name) as GraphQLEnumType)
        .getValues()
        .map(({ name: memberName, value }) => [memberName, value]);

    it("should not turn the reverse mapping of a non-finite member into a value", () => {
      expect(getValues("PageSize")).toEqual([
        ["SMALL", 10],
        ["LARGE", 100],
        ["ALL", Infinity],
        ["UNSET", NaN],
      ]);
    });

    it("should not turn the exports of a merged namespace into values", () => {
      expect(getValues("OrderStatus")).toEqual([
        ["PENDING", "PENDING"],
        ["SHIPPED", "SHIPPED"],
      ]);
    });

    it("should translate a default value given as the key of a member", () => {
      const [pageSize] = schema.getQueryType()!.getFields().orders!.args;
      expect(pageSize!.defaultValue).toBe(Infinity);
    });
  },
);
