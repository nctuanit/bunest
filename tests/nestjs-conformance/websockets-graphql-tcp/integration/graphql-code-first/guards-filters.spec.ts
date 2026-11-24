import { afterEach, beforeEach, expect, it } from "bun:test";
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
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Field,
  GqlExecutionContext,
  GraphQLModule,
  ID,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@ObjectType()
class Recipe {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;
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

@Injectable()
class DataInterceptor implements BunestInterceptor {
  async intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    return next.handle();
  }
}

@Injectable()
class RecipesService {
  async findOneById(_id: string): Promise<Recipe | undefined> {
    return undefined;
  }
}

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
}

@Module({
  providers: [
    RecipesResolver,
    RecipesService,
    {
      provide: APP_FILTER,
      useClass: UnauthorizedFilter,
    },
  ],
})
class RecipesModule {}

@Module({
  imports: [
    RecipesModule,
    GraphQLModule.forRoot({
      includeStacktraceInErrorResponses: false,
    }),
  ],
})
class AppModule {}

describeConformance(
  "GraphQL - Guards",
  {
    upstreamPath: "integration/graphql-code-first/e2e/guards-filters.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Verifies @UseGuards(AuthGuard) + global APP_FILTER @Catch(UnauthorizedException) in native @bunest/graphql.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should throw an error", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          operationName: null,
          variables: {},
          query: '{\n  recipe(id: "3") {\n    id\n  }\n}\n',
        })
        .expect(200);

      expect(res.body).toEqual({
        data: null,
        errors: [
          {
            message: "Unauthorized error",
            locations: [
              {
                line: 2,
                column: 3,
              },
            ],
            path: ["recipe"],
            extensions: {
              code: "INTERNAL_SERVER_ERROR",
            },
          },
        ],
      });
    });
  },
);
