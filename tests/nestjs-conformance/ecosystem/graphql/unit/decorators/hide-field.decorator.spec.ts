import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  type GraphQLObjectType,
  printType,
} from "../../../../../../packages/graphql/node_modules/graphql";
import { applyDecorators } from "../../../../../../packages/common/src";
import {
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  HideField,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../_helpers/index";

const METADATA_FACTORY_NAME = "_GRAPHQL_METADATA_FACTORY";

// A composed decorator the CLI plugin cannot see through
const Internal = () => applyDecorators(HideField());

// Shaped like a class compiled with the CLI plugin, which (not seeing through
// "Internal") still lists "resetToken" in the metadata factory.
@ObjectType()
class Account {
  @Field()
  email!: string;

  @Internal()
  resetToken!: string;

  static [METADATA_FACTORY_NAME]() {
    return {
      email: { type: () => String },
      resetToken: { type: () => String },
    };
  }
}

@Resolver(() => Account)
class AccountResolver {
  @Query(() => Account)
  account(): Account {
    return { email: "alice@example.com", resetToken: "secret" };
  }
}

describeConformance(
  "HideField",
  {
    upstreamPath: "packages/graphql/tests/decorators/hide-field.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS CLI plugin constant and passes resolver instance [new AccountResolver()] to GraphQLSchemaFactory.create().",
  },
  () => {
    it("should keep a member hidden through a composed decorator, even when the plugin lists it", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      const schema = await moduleRef
        .get(GraphQLSchemaFactory)
        .create([new AccountResolver()]);

      const accountType = schema.getType("Account") as GraphQLObjectType;
      expect(Object.keys(accountType.getFields())).toEqual(["email"]);
      expect(printType(accountType)).not.toContain("resetToken");
    });
  },
);
