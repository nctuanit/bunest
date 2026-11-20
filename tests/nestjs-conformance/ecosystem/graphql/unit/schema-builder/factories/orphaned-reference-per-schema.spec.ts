import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import type { GraphQLSchema } from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@ObjectType()
class AuditEntry {
  @Field()
  id!: string;
}

@ObjectType()
class Account {
  @Field()
  id!: string;
}

@Resolver()
class AdminResolver {
  @Query(() => AuditEntry)
  lastAuditEntry(): AuditEntry {
    return { id: "1" };
  }
}

@Resolver()
class PublicResolver {
  @Query(() => Account)
  me(): Account {
    return { id: "1" };
  }
}

describeConformance(
  "Orphaned references with multiple schemas",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/orphaned-reference-per-schema.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass resolver instances per @bunest/graphql API (ADR-013).",
  },
  () => {
    let adminSchema: GraphQLSchema;
    let publicSchema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      const schemaFactory = moduleRef.get(GraphQLSchemaFactory);

      adminSchema = await schemaFactory.create([new AdminResolver()]);
      publicSchema = await schemaFactory.create([new PublicResolver()]);
    });

    it("should not carry references over to the next schema", () => {
      expect(adminSchema.getType("AuditEntry")).toBeDefined();
      expect(publicSchema.getType("Account")).toBeDefined();
      expect(publicSchema.getType("AuditEntry")).toBeUndefined();
    });
  },
);
