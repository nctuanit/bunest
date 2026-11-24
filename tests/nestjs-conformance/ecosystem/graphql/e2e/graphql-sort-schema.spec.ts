import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  type GraphQLSchema,
  printSchema,
} from "../../../../../packages/graphql/src";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  ParseIntPipe,
  UseGuards,
} from "../../../../../packages/core/src/common";
import {
  ensureDir,
  join,
  removePath,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Args,
  GRAPHQL_SDL_FILE_HEADER,
  GqlExecutionContext,
  GraphQLModule,
  GraphQLSchemaHost,
  Mutation,
  PubSub,
  Query,
  ResolveField,
  Resolver,
  Subscription,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

interface Cat {
  readonly id: number;
  readonly name: string;
  readonly age: number;
}

@Injectable()
class CatsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const _ctx = GqlExecutionContext.create(context);
    return true;
  }
}

@Injectable()
class CatsService {
  private readonly cats: Cat[] = [{ id: 1, name: "Cat", age: 5 }];

  create(cat: Cat): Cat {
    this.cats.push(cat);
    return cat;
  }

  findAll(): Cat[] {
    return this.cats;
  }

  findOneById(id: number): Cat | undefined {
    return this.cats.find((cat) => cat.id === id);
  }
}

const pubSub = new PubSub();

@Resolver("Cat")
class CatsResolvers {
  constructor(private readonly catsService: CatsService) {}

  @Query(() => [Object], { name: "getCats" })
  @UseGuards(CatsGuard)
  async getCats() {
    return await this.catsService.findAll();
  }

  @ResolveField("color")
  getColor() {
    return "black";
  }

  @ResolveField()
  weight() {
    return 5;
  }

  @Query(() => Object, { name: "cat" })
  async findOneById(
    @Args("id", ParseIntPipe)
    id: number,
  ): Promise<Cat | undefined> {
    return await this.catsService.findOneById(id);
  }

  @Mutation(() => Object, { name: "createCat" })
  async create(@Args() args: Cat): Promise<Cat> {
    const createdCat = await this.catsService.create(args);
    await pubSub.publish("catCreated", { catCreated: createdCat });
    return createdCat;
  }

  @Subscription(() => Object, { name: "catCreated" })
  catCreated() {
    return pubSub.asyncIterator("catCreated");
  }
}

@Module({
  providers: [CatsService, CatsResolvers, CatsGuard],
})
class CatsModule {}

const CATS_SCHEMA_SDL = `type Query {
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
  color: String
  weight: Int
}
`;

const expectedSchema = `# ------------------------------------------------------
# THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)
# ------------------------------------------------------

type Cat {
  age: Int
  color: String
  id: Int
  name: String
  weight: Int
}

type Mutation {
  createCat(name: String): Cat
}

type Query {
  cat(id: ID!): Cat
  getCats: [Cat]
}

type Subscription {
  catCreated: Cat
}`;

describeConformance(
  "GraphQL sort schema",
  {
    upstreamPath: "packages/apollo/tests/e2e/graphql-sort-schema.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo schema-first sortSchema E2E to native @bunest/graphql using an isolated temp .graphql directory.",
  },
  () => {
    let app: BunestApplication;
    let schema: GraphQLSchema;
    let schemaDir: string;

    beforeEach(async () => {
      schemaDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-sort-schema-${crypto.randomUUID()}`,
      );
      await ensureDir(schemaDir);
      await Bun.write(join(schemaDir, "cats.types.graphql"), CATS_SCHEMA_SDL);

      @Module({
        imports: [
          CatsModule,
          GraphQLModule.forRoot({
            typePaths: [join(schemaDir, "**", "*.graphql")],
            sortSchema: true,
          }),
        ],
      })
      class SortSchemaModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [SortSchemaModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      const graphQLSchemaHost = app.get<GraphQLSchemaHost>(GraphQLSchemaHost);
      schema = graphQLSchemaHost.schema;
    });

    afterEach(async () => {
      await app.close();
      await removePath(schemaDir, { recursive: true, force: true });
    });

    it("should match schema snapshot", () => {
      expect(GRAPHQL_SDL_FILE_HEADER + printSchema(schema)).toEqual(
        expectedSchema,
      );
    });
  },
);
