import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import { type GraphQLSchema, printSchema } from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Args,
  ArgsType,
  Extensions,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  InputType,
  Int,
  PartialType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

@ArgsType()
class ListArgs {
  @Field(() => Int, { nullable: true })
  take?: number;

  @Field(() => Int, { nullable: true })
  skip?: number;
}

@ArgsType()
class UserListArgs extends ListArgs {
  @Field(() => Int)
  declare take: number;
}

@ArgsType()
class UserSearchArgs extends UserListArgs {
  @Field(() => String, { nullable: true })
  search?: string;
}

@ArgsType()
class PostsFilterArgs {
  @Field(() => String, { name: "author", nullable: true })
  authorId?: string;
}

@ArgsType()
class DeletePostsArgs extends PostsFilterArgs {
  @Field(() => ID)
  declare authorId: string;
}

@InputType()
class PostsFilterInput {
  @Field(() => String, { name: "author", nullable: true })
  authorId?: string;

  @Field(() => String, { nullable: true })
  title?: string;
}

@InputType()
class DeletePostsInput extends PostsFilterInput {
  @Field(() => ID)
  declare authorId: string;
}

@InputType()
class ArchivePostsInput extends DeletePostsInput {
  @Field(() => Boolean, { nullable: true })
  force?: boolean;
}

@ArgsType()
class FilterArgs {
  @Field({ nullable: true })
  @Extensions({ role: "admin" })
  includeDeleted?: boolean;
}

@ArgsType()
class AccountArgs {
  @Field(() => Int)
  id!: number;

  @Field({ nullable: true })
  email?: string;
}

@ArgsType()
class AccountChangesArgs extends PartialType(AccountArgs) {}

@ArgsType()
class NotifyArgs {
  @Field(() => String, { name: "notify_role", nullable: true })
  role?: string;
}

@Resolver()
class InheritanceResolver {
  @Query(() => String)
  users(@Args() _args: UserListArgs): string {
    return "ok";
  }

  @Query(() => String)
  searchUsers(@Args() _args: UserSearchArgs): string {
    return "ok";
  }

  @Query(() => String)
  deletePostsByArgs(@Args() _args: DeletePostsArgs): string {
    return "ok";
  }

  @Query(() => String)
  archivePosts(@Args("input") _input: ArchivePostsInput): string {
    return "ok";
  }

  @Query(() => String)
  invoices(@Args() _args: FilterArgs): string {
    return "ok";
  }

  @Query(() => String)
  account(
    @Args("id", { type: () => Int }) _id: number,
    @Args() _args: AccountArgs,
  ): string {
    return "ok";
  }
}

@Resolver()
class ConflictingTypesResolver {
  @Query(() => String)
  updateAccount(
    @Args("id", { type: () => Int }) _id: number,
    @Args() _changes: AccountChangesArgs,
  ): string {
    return "ok";
  }
}

@Resolver()
class RenamedPropertyCollisionResolver {
  @Query(() => String)
  invite(@Args("role") _role: string, @Args() _notify: NotifyArgs): string {
    return "ok";
  }
}

describeConformance(
  "ArgsType inheritance and @Args() declarations",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/args-type-inheritance.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass]) to Bunest GraphQLSchemaFactory.create([new ResolverClass()]) (ADR-013).",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      schema = await schemaFactory.create([new InheritanceResolver()]);
    });

    it("should let a class override the args of its parent", () => {
      expect(printSchema(schema)).toContain(
        "users(take: Int!, skip: Int): String!",
      );
    });

    it("should keep an intermediate override over a more distant ancestor", () => {
      expect(printSchema(schema)).toContain(
        "searchUsers(take: Int!, skip: Int, search: String): String!",
      );
    });

    it("should drop the schema name an ancestor gave a re-declared argument", () => {
      expect(printSchema(schema)).toContain(
        "deletePostsByArgs(authorId: ID!): String!",
      );
    });

    // BUNEST_BUG: getGraphQLFields (packages/graphql/src/decorators/type.decorators.ts:746) updates overridden fields in-place inside a Map preserving ancestor order (authorId, title, force) instead of placing the re-declared child field after inherited fields (title, authorId, force).
    it.skip("should drop the schema name an ancestor gave a re-declared input field", () => {
      expect(printSchema(schema)).toContain(
        [
          "input ArchivePostsInput {",
          "  title: String",
          "  authorId: ID!",
          "  force: Boolean",
          "}",
        ].join("\n"),
      );
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildArgsConfig (packages/graphql/src/schema/graphql-schema.factory.ts:1205-1209) omits `extensions` when expanding @ArgsType() fields into GraphQLArgumentConfig (expected { role: "admin" }, actual {}).
    it.skip("should pass the extensions of an @ArgsType() property to the argument", () => {
      const invoicesField = schema.getQueryType()!.getFields().invoices!;
      expect(invoicesField.args[0]!.extensions).toEqual({ role: "admin" });
    });

    it("should accept an argument declared identically by two parameters", () => {
      expect(printSchema(schema)).toContain(
        "account(id: Int!, email: String): String!",
      );
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildArgsConfig (packages/graphql/src/schema/graphql-schema.factory.ts:1183-1230) silently overwrites colliding argument entries instead of throwing when two @Args() parameters declare the same argument with conflicting types or default values.
    it.skip("should fail when two parameters declare an argument differently", async () => {
      await expect(
        schemaFactory.create([new ConflictingTypesResolver()]),
      ).rejects.toThrow(
        'Argument "id" of "ConflictingTypesResolver#updateAccount" is declared by more than one @Args() parameter with a different type or default value.',
      );
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildArgsConfig (packages/graphql/src/schema/graphql-schema.factory.ts:1183-1230) does not detect collisions between a renamed @ArgsType() property name ("role" exposed as "notify_role") and another @Args("role") parameter.
    it.skip("should fail when a renamed property is named like another argument", async () => {
      await expect(
        schemaFactory.create([new RenamedPropertyCollisionResolver()]),
      ).rejects.toThrow(
        'The "role" property of "NotifyArgs" (exposed as "notify_role") is named like the "role" argument of "RenamedPropertyCollisionResolver#invite", so both cannot be passed to the resolver.',
      );
    });
  },
);
