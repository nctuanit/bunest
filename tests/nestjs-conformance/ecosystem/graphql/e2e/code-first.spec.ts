import { afterEach, beforeEach, expect, it } from "bun:test";
import { Type } from "../../../../../packages/validation/src/transformer";
import {
  Length,
  Max,
  MaxLength,
  Min,
} from "../../../../../packages/validation/src/validator";
import {
  Kind,
  type ValueNode,
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
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  ArgsType,
  type CustomScalar,
  Field,
  type GqlExceptionFilter,
  GqlExecutionContext,
  GraphQLModule,
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
import { Test, describeConformance, request } from "../../../_helpers/index";

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
    return [
      new Recipe({
        id: "1",
        title: "Pizza",
        description: "Calzone",
        creationDate: new Date(),
      }),
      new Recipe({
        id: "2",
        title: "Spaghetti",
        creationDate: new Date(),
      }),
    ];
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

@Module({
  imports: [
    RecipesModule,
    DirectionsModule,
    GraphQLModule.forRoot({
      includeStacktraceInErrorResponses: false,
      autoSchemaFile: true,
    }),
  ],
})
class ApplicationModule {}

describeConformance(
  "Code-first",
  {
    upstreamPath: "packages/apollo/tests/e2e/code-first.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo code-first E2E (categories, search union, recipes with middleware/interfaceResolver/getters) to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ApplicationModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should return the categories result", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              categories {
                name
                description
                tags
              }
            }
          `,
        })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        categories: [
          {
            name: "Category #1",
            description: "default value",
            tags: [],
          },
        ],
      });
    });

    it("should return the search result", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              search {
                ... on Recipe {
                  title
                }
                ... on Ingredient {
                  name
                }
              }
            }
          `,
        })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        search: [
          {
            title: "recipe",
          },
          {
            name: "test",
          },
        ],
      });
    });

    it("should return query result (with description and interfaceResolver)", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              recipes {
                id
                description
                ingredients {
                  name
                }
                rating
                interfaceResolver
                averageRating
              }
            }
          `,
        })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        recipes: [
          {
            id: "1",
            description: "Description: Calzone",
            ingredients: [
              {
                name: "cherry",
              },
            ],
            rating: 10,
            interfaceResolver: true,
            averageRating: 0.5,
          },
          {
            id: "2",
            description: "Placeholder",
            ingredients: [
              {
                name: "cherry",
              },
            ],
            rating: 10,
            interfaceResolver: true,
            averageRating: 0.5,
          },
        ],
      });
    });

    it("should return query result (basic recipe fields)", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              recipes {
                id
                ingredients {
                  name
                }
                rating
                averageRating
              }
            }
          `,
        })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        recipes: [
          {
            id: "1",
            ingredients: [
              {
                name: "cherry",
              },
            ],
            rating: 10,
            averageRating: 0.5,
          },
          {
            id: "2",
            ingredients: [
              {
                name: "cherry",
              },
            ],
            rating: 10,
            averageRating: 0.5,
          },
        ],
      });
    });
  },
);
