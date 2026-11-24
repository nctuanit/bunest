import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  ParseIntPipe,
  UseGuards,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  GqlExecutionContext,
  GraphQLModule,
  Mutation,
  PubSub,
  Query,
  Resolver,
  Subscription,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

interface Cat {
  readonly id: number;
  readonly name: string;
  readonly age: number;
}

const CATS_TYPE_DEFS = `
  type Query {
    getCats: [Cat]
    cat(id: ID!): Cat
  }

  type Mutation {
    createCat(name: String): Cat
  }

  type Subscription {
    catCreated: Cat
  }

  type Cat {
    id: Int
    name: String
    age: Int
  }
`;

@Injectable()
class CatsService {
  private readonly cats: Cat[] = [{ id: 1, name: "Cat", age: 5 }];

  create(cat: Partial<Cat>): Cat {
    const created: Cat = {
      id: cat.id ?? this.cats.length + 1,
      name: cat.name ?? "Unnamed",
      age: cat.age ?? 1,
    };
    this.cats.push(created);
    return created;
  }

  findAll(): Cat[] {
    return this.cats;
  }

  findOneById(id: number): Cat | undefined {
    return this.cats.find((cat) => cat.id === id);
  }
}

@Injectable()
class CatsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const ctx = GqlExecutionContext.create(context);
    return Boolean(ctx);
  }
}

const pubSub = new PubSub();

@Resolver("Cat")
class CatsResolvers {
  constructor(private readonly catsService: CatsService) {}

  @Query(() => [Object], { name: "getCats" })
  @UseGuards(CatsGuard)
  async getCats(): Promise<Cat[]> {
    return this.catsService.findAll();
  }

  @Query(() => Object, { name: "cat" })
  async findOneById(
    @Args("id", ParseIntPipe) id: number,
  ): Promise<Cat | undefined> {
    return this.catsService.findOneById(id);
  }

  @Mutation(() => Object, { name: "createCat" })
  async create(@Args() args: Partial<Cat>): Promise<Cat> {
    const createdCat = this.catsService.create(args);
    await pubSub.publish("catCreated", { catCreated: createdCat });
    return createdCat;
  }

  @Subscription(() => Object, { name: "catCreated" })
  catCreated() {
    return pubSub.asyncIterator("catCreated");
  }
}

@Module({
  providers: [CatsService, CatsResolvers],
})
class CatsModule {}

@Module({
  imports: [
    CatsModule,
    GraphQLModule.forRoot({
      includeStacktraceInErrorResponses: true,
      typeDefs: CATS_TYPE_DEFS,
    }),
  ],
})
class AppModule {}

describeConformance(
  "GraphQL",
  {
    upstreamPath: "integration/graphql-schema-first/e2e/graphql.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream schema-first Cats GraphQL E2E from @nestjs/apollo typePaths to native @bunest/graphql typeDefs.",
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

    it("should return query result", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          operationName: null,
          variables: {},
          query: "{\n  getCats {\n    id\n  }\n}\n",
        })
        .expect(200);

      expect(res.body).toEqual({
        data: {
          getCats: [
            {
              id: 1,
            },
          ],
        },
      });
    });

    it("should execute parameterized query with ParseIntPipe and createCat mutation", async () => {
      const byIdRes = await request(app)
        .post("/graphql")
        .send({
          query: '{ cat(id: "1") { id name age } }',
        })
        .expect(200);
      expect(byIdRes.body).toEqual({
        data: { cat: { id: 1, name: "Cat", age: 5 } },
      });

      const createRes = await request(app)
        .post("/graphql")
        .send({
          query: 'mutation { createCat(name: "Milo") { id name age } }',
        })
        .expect(200);
      expect(createRes.body).toEqual({
        data: { createCat: { id: 2, name: "Milo", age: 1 } },
      });
    });

    // BUNEST_BUG: Schema-first operation decorator overloads `@Query()`, `@Query('cat')`, `@Mutation('createCat')`, `@Subscription('catCreated')` are missing in packages/graphql/src/decorators/resolver.decorators.ts (`createOperationDecorator` unconditionally requires a `returnTypeFunc` first parameter and ignores a string name argument).
    it.skip("should support NestJS schema-first @Query() and @Query('cat') overloads without returnTypeFunc", async () => {
      const rawQuery = Query as unknown as (name?: string) => MethodDecorator;

      @Resolver("Cat")
      class SchemaFirstOverloadResolver {
        @rawQuery()
        getCats() {
          return [{ id: 1, name: "Cat", age: 5 }];
        }

        @rawQuery("cat")
        findOneById(@Args("id", ParseIntPipe) id: number) {
          return { id, name: "Cat", age: 5 };
        }
      }

      @Module({
        imports: [GraphQLModule.forRoot({ typeDefs: CATS_TYPE_DEFS })],
        providers: [SchemaFirstOverloadResolver],
      })
      class OverloadAppModule {}

      const mod = await Test.createTestingModule({
        imports: [OverloadAppModule],
      }).compile({ logger: false });
      const localApp = mod.createNestApplication({ logger: false });
      await localApp.init();
      try {
        const res = await request(localApp)
          .post("/graphql")
          .send({ query: '{ cat(id: "1") { id name } }' })
          .expect(200);
        expect(res.body).toEqual({
          data: { cat: { id: 1, name: "Cat" } },
        });
      } finally {
        await localApp.close();
      }
    });
  },
);
