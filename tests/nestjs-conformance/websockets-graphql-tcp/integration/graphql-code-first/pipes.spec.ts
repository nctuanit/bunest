import { afterEach, expect, it } from "bun:test";
import { Type } from "../../../../../packages/validation/src/transformer";
import { Length, MaxLength } from "../../../../../packages/validation/src/validator";
import {
  Injectable,
  Module,
  UsePipes,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Field,
  GraphQLModule,
  ID,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  Test,
  bunestStrictValidationPipe,
  describeConformance,
  itAdapted,
  nestCompatibleValidationPipe,
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

@Injectable()
class RecipesService {
  async create(data: NewRecipeInput): Promise<Recipe> {
    return {
      id: "3",
      title: data.title,
      description: data.description,
      ingredients: data.ingredients,
    };
  }
}

@Resolver(() => Recipe)
class UnpipedRecipesResolver {
  constructor(private readonly recipesService: RecipesService) {}

  @Query(() => [Recipe])
  recipes(): Recipe[] {
    return [];
  }

  @Mutation(() => Recipe)
  async addRecipe(
    @Args("newRecipeData") newRecipeData: NewRecipeInput,
  ): Promise<Recipe> {
    return this.recipesService.create(newRecipeData);
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      includeStacktraceInErrorResponses: false,
    }),
  ],
  providers: [RecipesService, UnpipedRecipesResolver],
})
class GlobalPipeAppModule {}

describeConformance(
  "GraphQL Pipes",
  {
    upstreamPath: "integration/graphql-code-first/e2e/pipes.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-009"],
    notes:
      "Tests ValidationPipe enforcement on GraphQL mutation input DTOs (ADR-009 structured details vs NestJS list error format).",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    it("should throw an error when app.useGlobalPipes(ValidationPipe) rejects invalid GraphQL input", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GlobalPipeAppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      app.useGlobalPipes(nestCompatibleValidationPipe());
      await app.init();

      const res = await request(app)
        .post("/graphql")
        .send({
          operationName: null,
          variables: {},
          query:
            'mutation {\n  addRecipe(newRecipeData: {title: "test", ingredients: []}) {\n    id\n  }\n}\n',
        })
        .expect(200);

      expect(res.body).toMatchObject({
        data: null,
        errors: [
          {
            path: ["addRecipe"],
            locations: [{ line: 2, column: 3 }],
            extensions: {
              code: "BAD_REQUEST",
              originalError: { statusCode: 400 },
            },
          },
        ],
      });
    });

    itAdapted(
      ["ADR-009"],
      "should throw BAD_REQUEST GraphQL error with NestJS list messages when @UsePipes(nestCompatibleValidationPipe()) rejects input",
      async () => {
        @Resolver(() => Recipe)
        class NestPipeRecipesResolver {
          constructor(private readonly recipesService: RecipesService) {}

          @Query(() => [Recipe])
          recipes(): Recipe[] {
            return [];
          }

          @UsePipes(nestCompatibleValidationPipe())
          @Mutation(() => Recipe)
          async addRecipe(
            @Args("newRecipeData") newRecipeData: NewRecipeInput,
          ): Promise<Recipe> {
            return this.recipesService.create(newRecipeData);
          }
        }

        @Module({
          imports: [
            GraphQLModule.forRoot({
              includeStacktraceInErrorResponses: false,
            }),
          ],
          providers: [RecipesService, NestPipeRecipesResolver],
        })
        class LocalAppModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [LocalAppModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();

        const res = await request(app)
          .post("/graphql")
          .send({
            operationName: null,
            variables: {},
            query:
              'mutation {\n  addRecipe(newRecipeData: {title: "test", ingredients: []}) {\n    id\n  }\n}\n',
          })
          .expect(200);

        const body = res.body as {
          data: null;
          errors: Array<{
            message: string;
            locations: Array<{ line: number; column: number }>;
            path: string[];
            extensions: {
              code: string;
              originalError: { statusCode: number };
            };
          }>;
        };

        expect(body.data).toBeNull();
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0]).toMatchObject({
          message: "description must be longer than or equal to 30 characters",
          locations: [{ line: 2, column: 3 }],
          path: ["addRecipe"],
          extensions: {
            code: "BAD_REQUEST",
            originalError: { statusCode: 400 },
          },
        });
      },
    );

    itAdapted(
      ["ADR-009"],
      "should throw structured ValidationPipe details envelope with Bunest default strict ValidationPipe",
      async () => {
        @Resolver(() => Recipe)
        class StrictPipeRecipesResolver {
          constructor(private readonly recipesService: RecipesService) {}

          @Query(() => [Recipe])
          recipes(): Recipe[] {
            return [];
          }

          @UsePipes(bunestStrictValidationPipe())
          @Mutation(() => Recipe)
          async addRecipe(
            @Args("newRecipeData") newRecipeData: NewRecipeInput,
          ): Promise<Recipe> {
            return this.recipesService.create(newRecipeData);
          }
        }

        @Module({
          imports: [
            GraphQLModule.forRoot({
              includeStacktraceInErrorResponses: false,
            }),
          ],
          providers: [RecipesService, StrictPipeRecipesResolver],
        })
        class StrictAppModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [StrictAppModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();

        const res = await request(app)
          .post("/graphql")
          .send({
            query:
              'mutation {\n  addRecipe(newRecipeData: {title: "test", ingredients: []}) {\n    id\n  }\n}\n',
          })
          .expect(200);

        const body = res.body as {
          data: null;
          errors: Array<{
            message: string;
            path: string[];
            extensions: {
              code: string;
              originalError: { statusCode: number };
              details: Array<{ field: string; messages: string[] }>;
            };
          }>;
        };

        expect(body.data).toBeNull();
        expect(body.errors[0]?.message).toBe("Validation failed");
        expect(body.errors[0]?.path).toEqual(["addRecipe"]);
        expect(body.errors[0]?.extensions.code).toBe("BAD_REQUEST");
        expect(body.errors[0]?.extensions.originalError.statusCode).toBe(400);
        const descDetail = body.errors[0]?.extensions.details.find(
          (d) => d.field === "description",
        );
        expect(descDetail).toBeDefined();
        expect(descDetail?.messages).toContain(
          "description must be longer than or equal to 30 characters",
        );
        // ADR-009 strict default forbidNonWhitelisted also flags undecorated `ingredients`
        expect(
          body.errors[0]?.extensions.details.some(
            (d) => d.field === "ingredients",
          ),
        ).toBe(true);
      },
    );
  },
);
