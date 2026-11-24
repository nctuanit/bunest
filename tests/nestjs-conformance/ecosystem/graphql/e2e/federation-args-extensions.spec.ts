import { afterAll, beforeAll, expect, it } from "bun:test";
import type { GraphQLObjectType } from "../../../../../packages/graphql/src";
import { Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  ArgsType,
  Extensions,
  Field,
  GraphQLModule,
  GraphQLSchemaHost,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

@ArgsType()
class InvoiceFilterArgs {
  @Field({ nullable: true })
  @Extensions({ role: "admin" })
  includeDeleted?: boolean;
}

@ObjectType()
class Invoice {
  @Field()
  id!: string;
}

@Resolver(() => Invoice)
class InvoiceResolver {
  @Query(() => [Invoice])
  invoices(@Args() _filter: InvoiceFilterArgs): Invoice[] {
    return [];
  }

  @ResolveField(() => [Invoice])
  related(@Args() _filter: InvoiceFilterArgs): Invoice[] {
    return [];
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      federation: { version: 2 },
      autoSchemaFile: true,
    }),
  ],
  providers: [InvoiceResolver],
})
class ArgsExtensionsFederationModule {}

describeConformance(
  "Federation - extensions of the fields of an @ArgsType()",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation-args-extensions.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver @ArgsType() @Extensions() test to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013).",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ArgsExtensionsFederationModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it("should keep the extensions of the arguments in the federated schema", () => {
      const { schema } = app.get(GraphQLSchemaHost);
      const invoice = schema.getType("Invoice") as GraphQLObjectType;
      const queryType = schema.getQueryType()!;

      for (const field of [
        queryType.getFields().invoices!,
        invoice.getFields().related!,
      ]) {
        const [includeDeleted] = field.args;
        expect(includeDeleted!.name).toBe("includeDeleted");
        expect(includeDeleted!.extensions).toEqual(
          expect.objectContaining({ role: "admin" }),
        );
      }
    });
  },
);
