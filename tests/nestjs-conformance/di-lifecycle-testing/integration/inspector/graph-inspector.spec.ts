import { afterAll, beforeAll, expect } from "bun:test";
import {
  Catch,
  Controller,
  Get,
  Injectable,
  Module,
  Scope,
  Version,
  VersioningType,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type ExceptionFilter,
  type ExecutionContext,
} from "../../../../../packages/core/src/common";
import {
  GraphInspector,
  SerializedGraph,
  ValidationPipe,
} from "../../../../../packages/core/src";
import { InMemoryServer } from "../../../../../packages/microservices/src";
import {
  Test,
  type TestingModule,
  describeConformance,
  itAdapted,
} from "../../../_helpers";

@Injectable()
class CatsService {
  findAll() {
    return ["cat"];
  }
}

@Controller("cats")
class CatsController {
  constructor(private readonly catsService: CatsService) {}

  @Get()
  @Version("1")
  findAll() {
    return this.catsService.findAll();
  }
}

@Module({
  controllers: [CatsController],
  providers: [CatsService],
  exports: [CatsService],
})
class CatsModule {}

@Injectable({ scope: Scope.REQUEST })
class ScopedService {}

@Module({
  imports: [CatsModule],
  providers: [ScopedService],
})
class AppModule {}

@Catch()
class GlobalHttpFilter implements ExceptionFilter {
  catch(_exception: unknown, _host: ArgumentsHost) {
    return new Response("error", { status: 500 });
  }
}

@Injectable()
class TimeoutInterceptor implements BunestInterceptor {
  async intercept(_ctx: ExecutionContext, next: CallHandler) {
    return next.handle();
  }
}

describeConformance(
  "Graph inspector (integration)",
  {
    upstreamPath: "integration/inspector/e2e/graph-inspector.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007", "ADR-008"],
    notes:
      "Upstream compares exact NestJS internal JSON snapshot fixtures; adapted to assert structural completeness of @bunest/core SerializedGraph & GraphInspector pre-init and post-init.",
  },
  () => {
    let testingModule: TestingModule;

    beforeAll(async () => {
      testingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ snapshot: true });
    });

    afterAll(async () => {
      await testingModule.close();
    });

    itAdapted(
      "ADR-007",
      "should generate a pre-initialization SerializedGraph containing modules, providers, controllers, and edges",
      () => {
        const graph = testingModule.get(SerializedGraph);
        expect(graph).toBeInstanceOf(SerializedGraph);

        const json = graph.toJSON();
        const nodeLabels = Object.values(json.nodes).map((n) => n.label);
        expect(nodeLabels).toContain("AppModule");
        expect(nodeLabels).toContain("CatsModule");
        expect(nodeLabels).toContain("CatsService");
        expect(nodeLabels).toContain("CatsController");
        expect(nodeLabels).toContain("ScopedService");

        const moduleEdges = Object.values(json.edges).filter(
          (e) => e.metadata.type === "module-to-module",
        );
        expect(moduleEdges.length).toBeGreaterThanOrEqual(1);
        expect(JSON.parse(graph.toString())).toEqual(json);
      },
    );

    itAdapted(
      ["ADR-007", "ADR-008"],
      "should support post-initialization preview app with global enhancers, versioning, and microservice",
      async () => {
        const app = testingModule.createNestApplication({ preview: true });
        app.useGlobalPipes(new ValidationPipe());
        app.useGlobalFilters(new GlobalHttpFilter());
        app.useGlobalInterceptors(new TimeoutInterceptor());
        app.enableVersioning({ type: VersioningType.URI });
        app.connectMicroservice(new InMemoryServer());
        await app.init();

        const inspector = testingModule.get(GraphInspector);
        const graph = testingModule.get(SerializedGraph);
        expect(inspector.getSerializedGraph()).toBe(graph);
        expect(graph.status).toBe("complete");
        expect(Object.keys(graph.toJSON().nodes).length).toBeGreaterThanOrEqual(
          5,
        );
      },
    );
  },
);
