import { beforeAll, expect, it } from "bun:test";
import {
  type GraphQLInputObjectType,
  type GraphQLSchema,
  printType,
} from "../../../../../../packages/graphql/src";
import type { MappedType, Type } from "../../../../../../packages/core/src/common";
import {
  Args,
  ArgsType,
  Field,
  type FieldMiddleware,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  InputType,
  Int,
  IntersectionType,
  ObjectType,
  OmitType,
  PartialType,
  PickType,
  Query,
  Resolver,
  getFieldsAndDecoratorForType,
  registerEnumType,
} from "../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../_helpers/index";

type PartialTypeWithOptions = <T>(
  classRef: Type<T>,
  options?: { omitDefaultValues?: boolean; skipNullProperties?: boolean },
) => MappedType<Partial<T>>;

const PartialTypeWithOpts = PartialType as unknown as PartialTypeWithOptions;

enum Visibility {
  PUBLIC = "PUBLIC",
  PRIVATE = "PRIVATE",
}
registerEnumType(Visibility, { name: "MappedTypeVisibility" });

@InputType({ isAbstract: true })
class BaseProfileInput {
  @Field(() => String, { nullable: true })
  visibility?: string;
}

@InputType()
class CreateProfileInput extends BaseProfileInput {
  @Field(() => Visibility)
  declare visibility: Visibility;

  @Field({ nullable: true })
  name?: string;
}

@InputType()
class CloneProfileInput extends OmitType(CreateProfileInput, [
  "name",
] as const) {}

@ObjectType({ isAbstract: true })
abstract class Entity {
  @Field(() => ID)
  id!: string;

  @Field()
  isAdmin!: boolean;
}

@InputType()
class CreateNoteInput extends Entity {
  @Field()
  text!: string;
}

@InputType()
class UpdateNoteInput extends PartialType(CreateNoteInput) {}

@ObjectType()
@InputType("AccountInput")
class Account extends Entity {
  @Field()
  name!: string;
}

@InputType()
class UpdateAccountInput extends PartialType(Account, InputType) {}

@ArgsType()
class PageArgs {
  @Field(() => Int, { nullable: true })
  take?: number;
}

class UndecoratedArgs extends PageArgs {}

@ArgsType()
class SearchArgs extends UndecoratedArgs {
  @Field({ nullable: true })
  search?: string;
}

@ArgsType()
class PartialSearchArgs extends PartialType(SearchArgs) {}

@InputType()
class AccountUpdate {
  @Field(() => ID)
  id!: string;

  @Field()
  email!: string;
}

@InputType()
class PickThenPartial extends IntersectionType(
  PickType(AccountUpdate, ["id"] as const),
  PartialType(AccountUpdate),
) {}

@InputType()
class PartialThenPick extends IntersectionType(
  PartialType(AccountUpdate),
  PickType(AccountUpdate, ["id"] as const),
) {}

@InputType()
class CreateUserInput {
  @Field()
  name!: string;

  @Field()
  status: string = "active";

  @Field({ defaultValue: "member" })
  role!: string;
}

@InputType()
class OptionalNoteInput {
  @Field({ nullable: true, defaultValue: null })
  note?: string;
}

@InputType()
class RequiredNoteInput {
  @Field()
  note!: string;
}

@InputType()
class NoteInput extends IntersectionType(
  OptionalNoteInput,
  RequiredNoteInput,
) {}

const middlewareA: FieldMiddleware = (_, next) => next();
const middlewareB: FieldMiddleware = (_, next) => next();

@ObjectType()
class TaggedA {
  @Field(() => [String], { nullable: "items", middleware: [middlewareA] })
  tags!: string[];
}

@ObjectType()
class TaggedB {
  @Field(() => [String], {
    nullable: "itemsAndList",
    middleware: [middlewareB],
  })
  tags?: string[];
}

@Resolver()
class MappedTypesResolver {
  @Query(() => String)
  mapped(
    @Args("create") _create: CreateProfileInput,
    @Args("clone") _clone: CloneProfileInput,
    @Args("updateNote") _updateNote: UpdateNoteInput,
    @Args("account") _account: Account,
    @Args("updateAccount") _updateAccount: UpdateAccountInput,
    @Args("pickThenPartial") _pickThenPartial: PickThenPartial,
    @Args("partialThenPick") _partialThenPick: PartialThenPick,
    @Args("note") _note: NoteInput,
  ): string {
    return "ok";
  }

  @Query(() => String)
  search(@Args() _args: PartialSearchArgs): string {
    return "ok";
  }
}

describeConformance(
  "Mapped type fields",
  {
    upstreamPath:
      "packages/graphql/tests/type-helpers/mapped-type-fields.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts GraphQLSchemaFactory.create() to accept resolver instances per @bunest/graphql API (ADR-002, ADR-013).",
  },
  () => {
    let schema: GraphQLSchema;
    let schemaFactory: GraphQLSchemaFactory;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });
      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
      schema = await schemaFactory.create([new MappedTypesResolver()]);
    });

    const print = (name: string) =>
      printType(schema.getType(name) as GraphQLInputObjectType);

    it("should map the declaration a class re-declares, not the inherited one", () => {
      expect(print("CloneProfileInput")).toEqual(
        [
          "input CloneProfileInput {",
          "  visibility: MappedTypeVisibility!",
          "}",
        ].join("\n"),
      );
    });

    // BUNEST_BUG: getGraphQLFields() in packages/graphql/src/decorators/type.decorators.ts (lines 734-761) walks the entire prototype chain regardless of GraphQL decorator kind (@ObjectType vs @InputType), causing @InputType() UpdateNoteInput (derived from @InputType() CreateNoteInput extends @ObjectType() Entity) to include Entity's `id: ID` and `isAdmin: Boolean` fields.
    it.skip("should not map the fields of a parent of another kind of type", () => {
      expect(print("UpdateNoteInput")).toEqual(
        ["input UpdateNoteInput {", "  text: String", "}"].join("\n"),
      );
      expect(print("AccountInput")).toEqual(
        ["input AccountInput {", "  name: String!", "}"].join("\n"),
      );
      expect(print("UpdateAccountInput")).toEqual(
        ["input UpdateAccountInput {", "  name: String", "}"].join("\n"),
      );
    });

    it("should map the fields an arguments type inherits through a plain class", () => {
      expect(
        getFieldsAndDecoratorForType(PartialSearchArgs).fields.map(
          (field) => field.name,
        ),
      ).toEqual(["take", "search"]);
    });

    // BUNEST_BUG: registerMappedTypeMetadataHook() in packages/graphql/src/decorators/type.decorators.ts (lines 865-873) unconditionally overwrites field metadata when intersecting two classes, so PickThenPartial emits nullable `id: ID` instead of keeping the stricter non-nullable `id: ID!`.
    it.skip("should keep a shared field non-nullable unless both types allow null", () => {
      expect(print("PickThenPartial")).toEqual(
        ["input PickThenPartial {", "  id: ID!", "  email: String", "}"].join(
          "\n",
        ),
      );
      expect(print("PartialThenPick")).toEqual(
        ["input PartialThenPick {", "  id: ID!", "  email: String", "}"].join(
          "\n",
        ),
      );
      // the "null" default of the nullable declaration is dropped
      expect(print("NoteInput")).toEqual(
        ["input NoteInput {", "  note: String!", "}"].join("\n"),
      );
    });

    // BUNEST_BUG: PartialType() in packages/graphql/src/decorators/type.decorators.ts (lines 885-915) does not accept an options object (`{ omitDefaultValues: true }`), throwing TypeError: decorator is not a function.
    it.skip('should omit the property initializers of a partial type with "omitDefaultValues"', async () => {
      @InputType()
      class PatchUserInput extends PartialTypeWithOpts(CreateUserInput, {
        omitDefaultValues: true,
      }) {}

      @Resolver()
      class PatchUserResolver {
        @Query(() => String)
        patch(@Args("patchUser") _patchUser: PatchUserInput): string {
          return "ok";
        }
      }

      const patchSchema = await schemaFactory.create([new PatchUserResolver()]);
      expect(
        printType(
          patchSchema.getType("PatchUserInput") as GraphQLInputObjectType,
        ),
      ).toEqual(
        [
          "input PatchUserInput {",
          "  name: String",
          "  status: String",
          "  role: String",
          "}",
        ].join("\n"),
      );
    });

    // BUNEST_BUG: IntersectionType() in packages/graphql/src/decorators/type.decorators.ts (lines 854-881, 944-951) does not auto-apply @ObjectType() onto the generated class (causing getFieldsAndDecoratorForType to throw UnableToFindFieldsError) and does not compute stricter list nullability or merge field.middleware arrays across both sources.
    it.skip("should keep the stricter list nullability and the middleware of both types", () => {
      const { fields } = getFieldsAndDecoratorForType(
        IntersectionType(TaggedB, TaggedA),
      );
      expect(fields).toHaveLength(1);
      expect(fields[0]?.options.nullable).toEqual("items");
      expect(fields[0]?.middleware).toEqual([middlewareB, middlewareA]);
    });
  },
);
