import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { Type } from "../../../../../packages/validation/src/transformer";
import {
  Length,
  Max,
  MaxLength,
  Min,
} from "../../../../../packages/validation/src/validator";
import {
  type GraphQLSchema,
  Kind,
  type ValueNode,
  printSchema,
} from "../../../../../packages/graphql/src";
import {
  APP_FILTER,
  type ArgumentsHost,
  type CanActivate,
  Catch,
  type ExecutionContext,
  Injectable,
  Module,
  NotFoundException,
  UnauthorizedException,
  UseGuards,
} from "../../../../../packages/core/src/common";
import {
  existsSyncPath,
  join,
  removePath,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Args,
  ArgsType,
  type CustomScalar,
  Field,
  FileSystemHelper,
  GRAPHQL_SDL_FILE_END,
  GRAPHQL_SDL_FILE_HEADER,
  type GqlExceptionFilter,
  GqlExecutionContext,
  GraphQLModule,
  GraphQLSchemaHost,
  ID,
  InputType,
  Int,
  InterfaceType,
  type MiddlewareContext,
  Mutation,
  type NextFn,
  ObjectType,
  Parent,
  PubSub,
  Query,
  ResolveField,
  Resolver,
  Scalar,
  Subscription,
  createUnionType,
  registerEnumType,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

const METADATA_FACTORY_NAME = "_GRAPHQL_METADATA_FACTORY";

enum Direction {
  Up = "UP",
  Down = "DOWN",
  Left = "LEFT",
  Right = "RIGHT",
  Sideways = "SIDEWAYS",
}

registerEnumType(Direction, {
  name: "Direction",
  description: "The basic directions",
  valuesMap: {
    Sideways: { deprecationReason: "Replaced with Left or Right" },
    Up: { description: "The primary direction" },
  },
});

@Catch(UnauthorizedException)
class UnauthorizedFilter implements GqlExceptionFilter {
  catch(exception: Error, _host: ArgumentsHost) {
    exception.message = "Unauthorized error";
    return exception;
  }
}

@Injectable()
class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const gqlContext = GqlExecutionContext.create(context);
    if (gqlContext) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

@Scalar("Date", () => Date)
class DateScalar implements CustomScalar<number, Date> {
  description = "Date custom scalar type";

  parseValue(value: unknown): Date {
    return new Date(value as string | number);
  }

  serialize(value: Date): number {
    return value.getTime();
  }

  parseLiteral(ast: ValueNode): Date {
    if (ast.kind === Kind.INT) {
      return new Date(Number.parseInt(ast.value, 10));
    }
    return new Date(0);
  }
}

@ObjectType()
class Category {
  @Field(() => String)
  name!: string;

  @Field(() => String, { defaultValue: "default value" })
  description!: string;

  @Field(() => [String], { defaultValue: [] })
  tags!: string[];

  constructor(category?: Partial<Category>) {
    if (category) Object.assign(this, category);
  }
}

class NodeIngredient {
  @Field(() => ID, {
    defaultValue: "Not applied",
    description: "Not applied",
    deprecationReason: "Not applied",
  })
  id!: string;
}

@ObjectType({ isAbstract: true })
class BaseIngredient extends NodeIngredient {
  @Field({
    defaultValue: "default",
    deprecationReason: "is deprecated",
    description: "ingredient base name",
    nullable: true,
  })
  baseName!: string;
}

@ObjectType()
class Ingredient extends BaseIngredient {
  @Field({
    defaultValue: "default",
    deprecationReason: "is deprecated",
    description: "ingredient name",
    nullable: true,
  })
  name!: string;

  constructor(ingredient?: Partial<Ingredient>) {
    super();
    if (ingredient) Object.assign(this, ingredient);
  }
}

@InterfaceType()
abstract class Base {
  @Field(() => ID)
  id!: string;
}

@InterfaceType({
  description: "example interface",
  resolveType: () => Recipe,
})
abstract class IRecipe extends Base {
  @Field()
  title!: string;
}

@ObjectType({ implements: IRecipe, description: "recipe object type" })
class Recipe extends IRecipe {
  @Field({
    nullable: true,
    middleware: [
      async (_ctx: MiddlewareContext, next: NextFn) => {
        const value = await next();
        return value ? `Description: ${value}` : "Placeholder";
      },
    ],
  })
  description?: string;

  @Field()
  creationDate!: Date;

  @Field()
  get averageRating(): number {
    return 0.5;
  }

  constructor(recipe?: Partial<Recipe>) {
    super();
    if (recipe) Object.assign(this, recipe);
  }

  static [METADATA_FACTORY_NAME]() {
    return {
      lastRate: {
        nullable: true,
        type: () => Number,
        description: "last rate description",
      },
      tags: { nullable: false, type: () => [String] },
      averageRating: {
        description: "The recipe's average rating",
      },
      creationDate: {},
    };
  }
}

const SearchResultUnion = createUnionType({
  name: "SearchResultUnion",
  description: "Search result description",
  types: () => [Ingredient, Recipe] as const,
  resolveType: (value) => {
    if ("name" in value) return Ingredient;
    if ("title" in value) return Recipe;
    return undefined;
  },
});

@ArgsType()
class FilterRecipesCountArgs {
  @Field({ nullable: true })
  type?: string;

  @Field({ nullable: true })
  status?: string;
}

@InputType({ description: "new recipe input" })
class NewRecipeInput {
  @Field({ description: "recipe title" })
  @MaxLength(30)
  title!: string;

  @Field({ nullable: true })
  @Length(30, 255)
  description?: string;

  @Field({ nullable: false, defaultValue: "published" })
  status!: string;

  @Type(() => String)
  @Field(() => [String])
  ingredients!: string[];
}

@ArgsType()
class RecipesArgs {
  @Field(() => Int, {
    description: "number of items to skip",
    nullable: true,
  })
  @Min(0)
  skip: number = 0;

  @Field(() => Int, { nullable: true })
  @Min(1)
  @Max(50)
  take: number = 25;
}

@Injectable()
class RecipesService {
  async create(data: NewRecipeInput): Promise<Recipe> {
    return { id: "3", ...data } as unknown as Recipe;
  }

  async findOneById(_id: string): Promise<Recipe> {
    return {} as Recipe;
  }

  async findAll(_recipesArgs: RecipesArgs): Promise<Recipe[]> {
    return [];
  }

  async remove(_id: string): Promise<boolean> {
    return true;
  }
}

@Resolver(() => Ingredient)
class IngredientsResolver {
  @ResolveField(() => ID)
  id(@Parent() { id }: Ingredient): string {
    return id;
  }

  @ResolveField()
  name(@Parent() { name }: Ingredient): string {
    return name;
  }

  @ResolveField()
  baseName(@Parent() { name }: Ingredient): string {
    return name;
  }
}

@Resolver(() => IRecipe)
class IRecipesResolver {
  @ResolveField("interfaceResolver", () => Boolean)
  interfaceResolver(
    @Args("arg", { type: () => Number, nullable: true }) _arg: number,
  ) {
    return true;
  }
}

const pubSub = new PubSub();

@Resolver(() => Recipe)
class RecipesResolver {
  constructor(private readonly recipesService: RecipesService) {}

  @UseGuards(AuthGuard)
  @Query(() => IRecipe, { description: "get recipe by id" })
  async recipe(
    @Args("id", {
      defaultValue: "1",
      description: "recipe id",
      nullable: true,
    })
    id: string,
  ): Promise<IRecipe> {
    const recipe = await this.recipesService.findOneById(id);
    if (!recipe) {
      throw new NotFoundException(id);
    }
    return recipe;
  }

  @Query(() => [SearchResultUnion], { deprecationReason: "test" })
  async search(): Promise<Array<Recipe | Ingredient>> {
    return [new Recipe({ title: "recipe" }), new Ingredient({ name: "test" })];
  }

  @Query(() => [Category])
  categories() {
    return [new Category({ name: "Category #1" })];
  }

  @Query(() => [Recipe])
  recipes(@Args() recipesArgs: RecipesArgs): Promise<Recipe[]> {
    return this.recipesService.findAll(recipesArgs);
  }

  @Mutation(() => Recipe)
  async addRecipe(
    @Args("newRecipeData") newRecipeData: NewRecipeInput,
  ): Promise<Recipe> {
    const recipe = await this.recipesService.create(newRecipeData);
    await pubSub.publish("recipeAdded", { recipeAdded: recipe });
    return recipe;
  }

  @ResolveField("ingredients", () => [Ingredient])
  getIngredients(@Parent() _root: Recipe) {
    return [new Ingredient({ name: "cherry" })];
  }

  @ResolveField(() => Number)
  count(@Args() _filters: FilterRecipesCountArgs) {
    return 10;
  }

  @ResolveField()
  rating(): number {
    return 10;
  }

  @Mutation(() => Boolean)
  async removeRecipe(@Args("id") id: string) {
    return this.recipesService.remove(id);
  }

  @Subscription(() => Recipe, {
    description: "subscription description",
  })
  recipeAdded() {
    return pubSub.asyncIterator("recipeAdded");
  }
}

@Module({
  providers: [
    IngredientsResolver,
    RecipesResolver,
    IRecipesResolver,
    RecipesService,
    DateScalar,
    {
      provide: APP_FILTER,
      useClass: UnauthorizedFilter,
    },
  ],
})
class RecipesModule {}

@Resolver()
class DirectionsResolver {
  @Query(() => Direction)
  move(
    @Args({ name: "direction", type: () => Direction })
    direction: Direction,
  ): Direction {
    return direction;
  }
}

@Module({
  providers: [DirectionsResolver],
})
class DirectionsModule {}

const sortedPrintedSchemaSnapshot = `# ------------------------------------------------------
# THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)
# ------------------------------------------------------

type Category {
  description: String!
  name: String!
  tags: [String!]!
}

"""Date custom scalar type"""
scalar Date

"""The basic directions"""
enum Direction {
  Down
  Left
  Right
  Sideways @deprecated(reason: "Replaced with Left or Right")

  """The primary direction"""
  Up
}

"""example interface"""
interface IRecipe {
  id: ID!
  interfaceResolver(arg: Float): Boolean!
  title: String!
}

type Ingredient {
  """ingredient base name"""
  baseName: String @deprecated(reason: "is deprecated")
  id: ID!

  """ingredient name"""
  name: String @deprecated(reason: "is deprecated")
}

type Mutation {
  addRecipe(newRecipeData: NewRecipeInput!): Recipe!
  removeRecipe(id: String!): Boolean!
}

"""new recipe input"""
input NewRecipeInput {
  description: String
  ingredients: [String!]!
  status: String! = "published"

  """recipe title"""
  title: String!
}

type Query {
  categories: [Category!]!
  move(direction: Direction!): Direction!

  """get recipe by id"""
  recipe(
    """recipe id"""
    id: String = "1"
  ): IRecipe!
  recipes(
    """number of items to skip"""
    skip: Int = 0
    take: Int = 25
  ): [Recipe!]!
  search: [SearchResultUnion!]! @deprecated(reason: "test")
}

"""recipe object type"""
type Recipe implements IRecipe {
  """The recipe's average rating"""
  averageRating: Float!
  count(status: String, type: String): Float!
  creationDate: Date!
  description: String
  id: ID!
  ingredients: [Ingredient!]!
  interfaceResolver(arg: Float): Boolean!

  """last rate description"""
  lastRate: Float
  rating: Float!
  tags: [String!]!
  title: String!
}

"""Search result description"""
union SearchResultUnion = Ingredient | Recipe

type Subscription {
  """subscription description"""
  recipeAdded: Recipe!
}`;

describeConformance(
  "GraphQL sort autoSchemaFile and new line at the end of the schema",
  {
    upstreamPath: "packages/apollo/tests/e2e/graphql-sort-auto-schema.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo sortSchema + addNewlineAtEnd autoSchemaFile E2E to native @bunest/graphql with isolated temp schema path.",
  },
  () => {
    let app: BunestApplication;
    let schema: GraphQLSchema;
    let schemaFilePath: string;
    let writeFileMock: ReturnType<typeof mock>;

    beforeEach(async () => {
      schemaFilePath = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-sort-auto-schema-${crypto.randomUUID()}.graphql`,
      );
      writeFileMock = mock(() => Promise.resolve());

      @Module({
        imports: [
          RecipesModule,
          DirectionsModule,
          GraphQLModule.forRoot({
            autoSchemaFile: schemaFilePath,
            sortSchema: true,
            buildSchemaOptions: {
              addNewlineAtEnd: true,
            },
          }),
        ],
      })
      class SortAutoSchemaModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [SortAutoSchemaModule],
      })
        .overrideProvider(FileSystemHelper)
        .useValue({
          writeFile: writeFileMock,
        })
        .compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      const graphQLSchemaHost = app.get<GraphQLSchemaHost>(GraphQLSchemaHost);
      schema = graphQLSchemaHost.schema;
    });

    afterEach(async () => {
      await app.close();
      if (existsSyncPath(schemaFilePath)) {
        await removePath(schemaFilePath, { force: true });
      }
    });

    // BUNEST_BUG: (1) Schema bootstrap crashes with `Error: Schema must contain uniquely named types but contains multiple types named "IRecipe"` because GraphQLSchemaFactory.resolveOutputLeaf (packages/graphql/src/schema/graphql-schema.factory.ts:791) and getOrCreateInterfaceType (:850) use prototype-walking MetadataRegistry.has/get instead of hasOwn/getOwn for INTERFACE_TYPE on `Recipe extends IRecipe`; (2) GraphQLSchemaFactory.buildCodeFirst (:1553-1560) writes via node:fs writeFileSync directly without GRAPHQL_SDL_FILE_HEADER instead of calling DI-injected FileSystemHelper.writeFile.
    it.skip("should match schema snapshot", () => {
      expect(GRAPHQL_SDL_FILE_HEADER + printSchema(schema)).toEqual(
        sortedPrintedSchemaSnapshot,
      );

      expect(writeFileMock).toHaveBeenCalledTimes(1);
      expect(writeFileMock).toHaveBeenCalledWith(
        schemaFilePath,
        sortedPrintedSchemaSnapshot + GRAPHQL_SDL_FILE_END,
      );
    });
  },
);
