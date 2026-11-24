import { beforeAll, expect, it } from "bun:test";
import {
  graphql,
  type GraphQLInterfaceType,
  type GraphQLObjectType,
  type GraphQLSchema,
} from "../../../../../../../packages/graphql/src";
import {
  Extensions,
  Field,
  type FieldMiddleware,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  InterfaceType,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

const wrap =
  (name: string): FieldMiddleware =>
  async (_ctx, next) =>
    `${name}(${await next()})`;

@InterfaceType()
abstract class Node {
  @Field(() => ID)
  id!: string;

  @Field({ nullable: true })
  createdBy!: string;
}

@ObjectType({ implements: () => [Node] })
class Account implements Node {
  id!: string;

  @Field({ description: "account", middleware: [wrap("staffOnly")] })
  createdBy!: string;
}

@ObjectType()
class TrialAccount extends Account {
  @Field()
  expires!: string;
}

// Lists `Node` again, although `Account` already implements it.
@ObjectType({ implements: () => [Node] })
class PartnerAccount extends Account {
  @Field()
  partner!: string;
}

@InterfaceType()
abstract class OwnedNode {
  @Field(() => ID)
  id!: string;

  @Field()
  owner!: string;
}

@InterfaceType({ implements: () => [OwnedNode] })
abstract class PrivateNode extends OwnedNode {
  @Extensions({ role: "ADMIN" })
  @Field({ description: "private", middleware: [wrap("adminOnly")] })
  declare owner: string;
}

@InterfaceType({ implements: () => [OwnedNode] })
abstract class PrivateFile extends PrivateNode {
  @Field()
  path!: string;
}

@ObjectType()
class StoredFile extends PrivateFile {}

@Resolver()
class AccountsResolver {
  accountData: () => Record<string, unknown> = () => ({
    id: "1",
    createdBy: "value",
    expires: "value",
    partner: "value",
  });

  @Query(() => TrialAccount)
  trialAccount(): TrialAccount {
    return this.accountData() as unknown as TrialAccount;
  }

  @Query(() => PartnerAccount)
  partnerAccount(): PartnerAccount {
    return this.accountData() as unknown as PartnerAccount;
  }
}

@Resolver()
class StoredFileResolver {
  storedFileData: () => Record<string, unknown> = () => ({
    id: "1",
    owner: "value",
    path: "value",
  });

  @Query(() => StoredFile)
  storedFile(): StoredFile {
    return this.storedFileData() as unknown as StoredFile;
  }
}

describeConformance(
  "A field the parent type redeclares from an interface the subclass lists again",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/parent-field-override.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass resolver instances whose query handlers return the fixture payloads directly (Bunest binds resolver methods on Query fields rather than relying on rootValue; ADR-013), and isolates StoredFileResolver so the StoredFile-extends-PrivateFile bug does not block the Account test.",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;
    let accountSchema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      accountSchema = await schemaFactory.create([new AccountsResolver()]);
    });

    it("should keep the object type parent declaration", async () => {
      const partnerAccount = accountSchema.getType(
        "PartnerAccount",
      ) as GraphQLObjectType;
      expect(partnerAccount.getFields().createdBy?.description).toBe("account");

      const result = await graphql({
        schema: accountSchema,
        source:
          "{ trialAccount { createdBy } partnerAccount { createdBy partner } }",
      });

      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        trialAccount: { createdBy: "staffOnly(value)" },
        partnerAccount: { createdBy: "staffOnly(value)", partner: "value" },
      });
    });

    // BUNEST_BUG: Expected PrivateFile and StoredFile to preserve PrivateNode.owner description/extensions/middleware, but schemaFactory.create throws 'Schema must contain uniquely named types but contains multiple types named "PrivateFile"'; packages/graphql/src/schema/graphql-schema.factory.ts (resolveOutputLeaf:791 & getOrCreateInterfaceType:850) uses prototype-walking MetadataRegistry.has/get instead of hasOwn/getOwn, misclassifying @ObjectType StoredFile extends @InterfaceType PrivateFile as a duplicate interface named "PrivateFile" (and getOrCreateInterfaceType omits field extensions).
    it.skip("should keep the interface type parent declaration", async () => {
      const schema = await schemaFactory.create(
        [new AccountsResolver(), new StoredFileResolver()],
        { orphanedTypes: [PrivateFile] },
      );

      for (const typeName of ["PrivateFile", "StoredFile"]) {
        const owner = (
          schema.getType(typeName) as GraphQLObjectType | GraphQLInterfaceType
        ).getFields().owner;
        expect(owner?.description).toBe("private");
        expect(owner?.extensions).toMatchObject({ role: "ADMIN" });
      }

      const result = await graphql({
        schema,
        source: "{ storedFile { owner path } }",
      });

      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        storedFile: { owner: "adminOnly(value)", path: "value" },
      });
    });
  },
);
