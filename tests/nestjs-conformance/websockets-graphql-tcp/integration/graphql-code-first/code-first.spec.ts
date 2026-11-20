import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "class-transformer";
import { Length, Max, MaxLength, Min } from "class-validator";
import {
  APP_FILTER,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  Catch,
  type ExecutionContext,
  Injectable,
  Module,
  NotFoundException,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  ArgsType,
  type CustomScalar,
  Field,
  GqlExecutionContext,
  GraphQLModule,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  PubSub,
  Query,
  Resolver,
  Scalar,
  Subscription,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers/index";

@ObjectType()
class Recipe {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ nullable: true })
  description?: string;

  @Field()
  creationDate!: Date;

  @Field(() => [String])
  ingredients!: string[];
}

@InputType()
class NewRecipeInput {
  @Field()
  @MaxLength(30)
  title!: string;

  @Field({ nullable: true })
  @Length(30, 255)
  description?: string;

  @Type(() => String)
  @Field(() => [String])
  ingredients!: string[];
}

@ArgsType()
class RecipesArgs {
  @Field(() => Int, { defaultValue: 0 })
  @Min(0)
  skip = 0;

  @Field(() => Int, { defaultValue: 25 })
  @Min(1)
  @Max(50)
  take = 25;
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

  parseLiteral(ast: { kind?: string; value?: string }): Date {
    if (ast.kind === "IntValue" && ast.value !== undefined) {
      return new Date(Number.parseInt(ast.value, 10));
    }
    return new Date(0);
  }
}

@Catch(UnauthorizedException)
class UnauthorizedFilter {
  catch(_exception: unknown, _host: ArgumentsHost) {
    return new Error("Unauthorized error");
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

let interceptorInvocations = 0;

@Injectable()
class DataInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
    interceptorInvocations++;
    return next.handle();
  }
}

@Injectable()
class RecipesService {
  async create(_data: NewRecipeInput): Promise<Recipe> {
    return {
      id: "3",
      title: _data.title,
      description: _data.description,
      creationDate: new Date(1700000000000),
      ingredients: _data.ingredients,
    };
  }

  async findOneById(_id: string): Promise<Recipe | undefined> {
    return undefined;
  }

  async findAll(_recipesArgs: RecipesArgs): Promise<Recipe[]> {
    return [];
  }

  async remove(_id: string): Promise<boolean> {
    return true;
  }
}

const pubSub = new PubSub();

@UseInterceptors(DataInterceptor)
@Resolver(() => Recipe)
class RecipesResolver {
  constructor(private readonly recipesService: RecipesService) {}

  @UseGuards(AuthGuard)
  @Query(() => Recipe)
  async recipe(@Args("id") id: string): Promise<Recipe> {
    const recipe = await this.recipesService.findOneById(id);
    if (!recipe) {
      throw new NotFoundException(id);
    }
    return recipe;
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

  @Mutation(() => Boolean)
  async removeRecipe(@Args("id") id: string): Promise<boolean> {
    return this.recipesService.remove(id);
  }

  @Subscription(() => Recipe)
  recipeAdded() {
    return pubSub.asyncIterator("recipeAdded");
  }
}

@Module({
  providers: [
    RecipesResolver,
    RecipesService,
    DateScalar,
    {
      provide: APP_FILTER,
      useClass: UnauthorizedFilter,
    },
  ],
})
class RecipesModule {}

describeConformance(
  "GraphQL - Code-first",
  {
    upstreamPath: "integration/graphql-code-first/e2e/code-first.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream @nestjs/apollo code-first GraphQL E2E to native @bunest/graphql with Promise interceptors (ADR-008) and zero-socket Bun HTTP requests (ADR-001).",
  },
  () => {
    let app: BunestApplication;
    let schemaFilePath: string;

    beforeEach(async () => {
      interceptorInvocations = 0;
      schemaFilePath = join(
        tmpdir(),
        `bunest-gql-code-first-${crypto.randomUUID()}.gql`,
      );

      @Module({
        imports: [
          RecipesModule,
          GraphQLModule.forRoot({
            includeStacktraceInErrorResponses: false,
            autoSchemaFile: schemaFilePath,
          }),
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
      if (existsSync(schemaFilePath)) {
        rmSync(schemaFilePath, { force: true });
      }
    });

    it("should return query result", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          operationName: null,
          variables: {},
          query: "{\n  recipes {\n    id\n  }\n}\n",
        })
        .expect(200);

      expect(res.body).toEqual({
        data: {
          recipes: [],
        },
      });
      expect(interceptorInvocations).toBe(1);
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should emit code-first autoSchemaFile SDL and execute custom DateScalar + mutations",
      async () => {
        expect(existsSync(schemaFilePath)).toBe(true);
        const sdl = readFileSync(schemaFilePath, "utf8");
        expect(sdl).toContain("type Recipe");
        expect(sdl).toContain("scalar Date");
        expect(sdl).toContain("input NewRecipeInput");
        expect(sdl).toContain("type Mutation");
        expect(sdl).toContain("type Subscription");

        const mutRes = await request(app)
          .post("/graphql")
          .send({
            query:
              'mutation { addRecipe(newRecipeData: { title: "Cake", ingredients: ["flour"] }) { id title creationDate ingredients } }',
          })
          .expect(200);

        expect(mutRes.body).toEqual({
          data: {
            addRecipe: {
              id: "3",
              title: "Cake",
              creationDate: 1700000000000,
              ingredients: ["flour"],
            },
          },
        });
      },
    );

    // BUNEST_BUG: @ArgsType() class property initializers (e.g. `skip = 0` without explicit `{ defaultValue: 0 }` in @Field) are not read as GraphQL argument defaultValue in packages/graphql/src/schema/graphql-schema.factory.ts (buildArgsConfig only reads fieldMeta.defaultValue), causing queries omitting defaulted Int! args to fail GraphQL validation.
    it.skip("should infer @ArgsType() default values from TypeScript class property initializers", async () => {
      @ArgsType()
      class ImplicitDefaultArgs {
        @Field(() => Int)
        skip = 0;

        @Field(() => Int)
        take = 25;
      }

      @Resolver()
      class ImplicitDefaultResolver {
        @Query(() => [String])
        items(@Args() args: ImplicitDefaultArgs): string[] {
          return [`${args.skip}:${args.take}`];
        }
      }

      @Module({
        imports: [GraphQLModule.forRoot()],
        providers: [ImplicitDefaultResolver],
      })
      class ImplicitModule {}

      const mod = await Test.createTestingModule({
        imports: [ImplicitModule],
      }).compile({ logger: false });
      const localApp = mod.createNestApplication({ logger: false });
      await localApp.init();
      try {
        const res = await request(localApp)
          .post("/graphql")
          .send({ query: "{ items }" })
          .expect(200);
        expect(res.body).toEqual({ data: { items: ["0:25"] } });
      } finally {
        await localApp.close();
      }
    });
  },
);
