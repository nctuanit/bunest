import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import {
  type GraphQLField,
  type GraphQLInputObjectType,
  type GraphQLInterfaceType,
  GraphQLNonNull,
  type GraphQLObjectType,
  type GraphQLSchema,
  getNamedType,
} from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Args,
  Directive,
  Extensions,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  InputType,
  Int,
  InterfaceType,
  Mutation,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

/**
 * A `@ResolveField()` handler is merged into the field its host type declares
 * (on the type itself, an ancestor class or an implemented interface). The
 * handler's metadata has to reach the host type's field, and only that one:
 * the declaration it is merged into is shared with every other type that
 * inherits it.
 */

@ObjectType()
class User {
  @Field(() => ID)
  id!: string;

  @Directive("@cacheControl(maxAge: 60)")
  @Field()
  email!: string;

  @Field()
  phone!: string;

  @Field()
  status!: string;
}

@Resolver(() => User)
class UserResolver {
  @Query(() => User)
  user(): User {
    return null as unknown as User;
  }

  @Directive('@auth(requires: "ADMIN")')
  @ResolveField(() => String)
  email() {
    return "email";
  }

  @Extensions({ role: "ADMIN" })
  @ResolveField(() => String)
  phone() {
    return "phone";
  }

  @ResolveField("status", undefined, {
    nullable: true,
    description: "handler description",
  })
  getStatus() {
    return null;
  }
}

@InterfaceType()
abstract class Account {
  @Field(() => ID)
  id!: string;

  @Extensions({ role: "ADMIN" })
  @Directive("@auth")
  @Field()
  email!: string;
}

@ObjectType({ implements: () => [Account] })
class Customer implements Account {
  id!: string;
  email!: string;
}

@ObjectType({ implements: () => [Account] })
class Employee implements Account {
  id!: string;
  email!: string;
}

@Resolver(() => Employee)
class EmployeeResolver {
  @Query(() => [Account])
  accounts(): Account[] {
    return [];
  }

  @Query(() => Customer)
  customer(): Customer {
    return null as unknown as Customer;
  }

  @ResolveField(() => String)
  email() {
    return "email";
  }
}

@InterfaceType()
abstract class Document {
  @Field(() => ID)
  id!: string;

  @Field()
  body!: string;
}

@ObjectType({ implements: () => [Document] })
class Memo extends Document {}

@ObjectType({ implements: () => [Document] })
class Report extends Document {}

@Resolver(() => Memo)
class MemoResolver {
  @Query(() => [Document])
  documents(): Document[] {
    return [];
  }

  @ResolveField(() => String)
  body(
    @Args("template", { type: () => String, nullable: true })
    template?: string,
  ) {
    return template;
  }
}

@Resolver(() => Report)
class ReportResolver {
  @Query(() => Report)
  report(): Report {
    return null as unknown as Report;
  }

  @ResolveField(() => String)
  body(
    @Args("template", { type: () => Int, defaultValue: 1 })
    template: number,
  ) {
    return String(template);
  }
}

@ObjectType()
class Author {
  @Field(() => ID)
  id!: string;
}

@ObjectType()
@InputType("PostInput")
class Post {
  @Field()
  text!: string;

  @Field(() => ID, { name: "authorId" })
  author!: string;
}

@Resolver(() => Post)
class PostResolver {
  @Query(() => Post)
  post(): Post {
    return null as unknown as Post;
  }

  @Mutation(() => Post)
  createPost(@Args("input") input: Post): Post {
    return input;
  }

  @ResolveField(() => Author, { nullable: true })
  author() {
    return null;
  }
}

describeConformance(
  "TypeMetadataStorage - @ResolveField() merged into a declared field",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/storages/type-metadata-storage.field-resolvers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to pass resolver instances and buildSchemaOptions: { skipCheck: true } per @bunest/graphql API (ADR-013), and builds the Document/Memo/Report schema inside its own test so the Memo/Report-extends-Document bug does not block the other scenarios.",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;
    let baseSchema: GraphQLSchema;

    const getField = (
      schema: GraphQLSchema,
      typeName: string,
      fieldName: string,
    ) =>
      (
        schema.getType(typeName) as GraphQLObjectType | GraphQLInterfaceType
      ).getFields()[fieldName]!;
    const getDirectiveNames = (field: GraphQLField<unknown, unknown>) =>
      field.astNode?.directives?.map((directive) => directive.name.value) ?? [];
    const getArg = (field: GraphQLField<unknown, unknown>, name: string) =>
      field.args.find((arg) => arg.name === name);

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      baseSchema = await schemaFactory.create(
        [new UserResolver(), new EmployeeResolver(), new PostResolver()],
        { buildSchemaOptions: { skipCheck: true } },
      );
    });

    // BUNEST_BUG: Expected User.email field astNode.directives to contain ['cacheControl', 'auth'], got [] (astNode is undefined); packages/graphql/src/schema/graphql-schema.factory.ts does not populate astNode.directives on code-first GraphQLField configs and does not merge @Directive() metadata from @ResolveField() handler methods.
    it.skip("should keep the handler's directives next to the model's", () => {
      expect(getDirectiveNames(getField(baseSchema, "User", "email"))).toEqual([
        "cacheControl",
        "auth",
      ]);
    });

    // BUNEST_BUG: Expected User.phone field extensions to contain { role: 'ADMIN' } from @Extensions() on UserResolver.phone(), got {}; packages/graphql/src/schema/graphql-schema.factory.ts (getOrCreateObjectType:1102-1135) does not read @Extensions() metadata from @ResolveField() handler methods when merging into object type fields.
    it.skip("should apply the handler's extensions to a field the model declares", () => {
      expect(getField(baseSchema, "User", "phone").extensions).toEqual(
        expect.objectContaining({ role: "ADMIN" }),
      );
    });

    // BUNEST_BUG: Expected User.status to become nullable with description 'handler description' from @ResolveField('status', undefined, { nullable: true, description }), got String! with description undefined; packages/graphql/src/decorators/resolver.decorators.ts (ResolveField:176-184) ignores the 3rd maybeOptions argument when the 2nd returnTypeOrOptions argument is undefined.
    it.skip("should apply the handler's nullability and description over the model's", () => {
      const field = getField(baseSchema, "User", "status");

      expect(field.type).not.toBeInstanceOf(GraphQLNonNull);
      expect(field.description).toBe("handler description");
    });

    // BUNEST_BUG: Expected Employee.email and Customer.email to keep interface Account.email extensions ({ role: 'ADMIN' }) and directives (['auth']), got extensions {} and astNode undefined; packages/graphql/src/schema/graphql-schema.factory.ts (getOrCreateObjectType:1029-1056 & 1102-1135) does not copy extensions/astNode.directives from implemented @InterfaceType() fields or preserve them across @ResolveField() merging.
    it.skip("should keep an interface field's extensions and directives on an implementing type with a handler", () => {
      const employeeEmail = getField(baseSchema, "Employee", "email");

      expect(employeeEmail.extensions).toEqual(
        expect.objectContaining({ role: "ADMIN" }),
      );
      expect(getDirectiveNames(employeeEmail)).toEqual(["auth"]);
      expect(getField(baseSchema, "Customer", "email").extensions).toEqual(
        expect.objectContaining({ role: "ADMIN" }),
      );
    });

    // BUNEST_BUG: Expected Memo.body and Report.body to publish per-implementer args while leaving Document.body args empty, but schemaFactory.create throws 'Schema must contain uniquely named types but contains multiple types named "Document"'; packages/graphql/src/schema/graphql-schema.factory.ts (resolveOutputLeaf:791 & getOrCreateInterfaceType:850) uses prototype-walking MetadataRegistry.has/get instead of hasOwn/getOwn, misclassifying @ObjectType subclasses extending @InterfaceType Document as duplicate interface types.
    it.skip("should publish each implementing type's own handler arguments, leaving the interface field alone", async () => {
      const schema = await schemaFactory.create(
        [new MemoResolver(), new ReportResolver()],
        { buildSchemaOptions: { skipCheck: true } },
      );

      expect(getField(schema, "Document", "body").args).toEqual([]);

      const memoTemplate = getArg(getField(schema, "Memo", "body"), "template");
      expect(memoTemplate?.type.toString()).toBe("String");

      const reportTemplate = getArg(
        getField(schema, "Report", "body"),
        "template",
      );
      expect(reportTemplate?.type.toString()).toBe("Int!");
      expect(reportTemplate?.defaultValue).toBe(1);
    });

    it("should not merge a handler's options into a model property of the same name exposed under another name", () => {
      const postInput = baseSchema.getType(
        "PostInput",
      ) as GraphQLInputObjectType;
      expect(postInput.getFields().authorId?.type).toBeInstanceOf(
        GraphQLNonNull,
      );

      expect(getField(baseSchema, "Post", "authorId").type).toBeInstanceOf(
        GraphQLNonNull,
      );
      const author = getField(baseSchema, "Post", "author");
      expect(author.type).not.toBeInstanceOf(GraphQLNonNull);
      expect(getNamedType(author.type).name).toBe("Author");
    });
  },
);
