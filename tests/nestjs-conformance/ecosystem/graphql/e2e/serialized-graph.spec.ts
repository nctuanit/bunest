import { afterAll, beforeAll, expect, it } from "bun:test";
import { Injectable, Module } from "../../../../../packages/core/src/common";
import {
  type BunestApplication,
  SerializedGraph,
} from "../../../../../packages/core/src";
import {
  Field,
  GraphQLModule,
  ID,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { ValidationPipe } from "../../../../../packages/validation/src";
import {
  Test,
  type TestingModule,
  describeConformance,
} from "../../../_helpers/index";

@ObjectType()
class Recipe {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;
}

@Injectable()
class RecipesService {
  findAll(): Recipe[] {
    return [{ id: "1", title: "Pasta" }];
  }
}

@Resolver(() => Recipe)
class RecipesResolver {
  constructor(private readonly recipesService: RecipesService) {}

  @Query(() => [Recipe])
  recipes(): Recipe[] {
    return this.recipesService.findAll();
  }
}

@Module({
  providers: [RecipesService, RecipesResolver],
})
class RecipesModule {}

@Resolver()
class DirectionsResolver {
  @Query(() => String)
  move(): string {
    return "NORTH";
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
  "Serialized graph",
  {
    upstreamPath: "packages/apollo/tests/e2e/serialized-graph.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts @nestjs/apollo serialized-graph snapshot E2E to Bunest SerializedGraph with snapshot/preview options and explicit structural assertions.",
  },
  () => {
    let testingModule: TestingModule;
    let app: BunestApplication | undefined;

    beforeAll(async () => {
      testingModule = await Test.createTestingModule({
        imports: [ApplicationModule],
      }).compile({ logger: false, snapshot: true, preview: true });
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      } else {
        await testingModule.close();
      }
    });

    it("should generate a post-initialization graph and match serialized structure", async () => {
      app = testingModule.createNestApplication({
        logger: false,
        preview: true,
      });
      app.useGlobalPipes(new ValidationPipe());
      await app.init();

      const graph = testingModule.get(SerializedGraph);
      const serialized = graph.toString();
      const parsed = JSON.parse(serialized) as {
        nodes: Record<string, { label: string; metadata: { type: string } }>;
        edges: Record<string, { source: string; target: string }>;
        status: string;
      };

      expect(parsed.status).toBe("complete");
      const labels = Object.values(parsed.nodes).map((n) => n.label);
      expect(labels).toContain("ApplicationModule");
      expect(labels).toContain("GraphQLModule");
      expect(labels).toContain("RecipesModule");
      expect(labels).toContain("DirectionsModule");
      expect(labels).toContain("RecipesResolver");
      expect(labels).toContain("RecipesService");
      expect(labels).toContain("DirectionsResolver");
      expect(Object.keys(parsed.edges).length).toBeGreaterThan(0);
    });
  },
);
