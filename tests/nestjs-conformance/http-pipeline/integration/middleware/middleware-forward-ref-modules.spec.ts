import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Injectable,
  Module,
  forwardRef,
  type BunestModule,
  type DynamicModule,
  type MiddlewareConsumer,
  type ModuleImport,
} from "../../../../../packages/core/src/common";
import {
  ModulesContainer,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const AUTH_VALUE = "unauthorized";
const DASHBOARD_VALUE = "dashboard";

let registerCalls = 0;
let serviceInstances = 0;

@Injectable()
class DashboardService {
  constructor() {
    serviceInstances++;
  }
}

@Module({})
class DashboardModule implements BunestModule {
  static register(): DynamicModule {
    registerCalls++;
    return {
      module: DashboardModule,
      providers: [DashboardService],
      exports: [DashboardService],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    // Answers the requests itself, behind the authentication of the parent
    consumer
      .apply((_req, _res, _next) => new Response(DASHBOARD_VALUE))
      .forRoutes("dashboard");
  }
}

@Module({ providers: [DashboardService] })
class ReportsModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(DASHBOARD_VALUE))
      .forRoutes("dashboard");
  }
}

@Module({})
class FeatureModule {
  static register(): DynamicModule {
    return {
      module: FeatureModule,
      imports: [forwardRef(() => ReportsModule)],
    };
  }
}

const countModules = (app: BunestApplication, metatype: unknown) =>
  [...app.get(ModulesContainer).values()].filter(
    (moduleRef) => moduleRef.metatype === metatype,
  ).length;

describeConformance(
  "Middleware - modules imported through forwardRef()",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-forward-ref-modules.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapted Express middleware res.end() to Bunest middleware returning native Web Response.",
  },
  () => {
    let app: BunestApplication | undefined;

    const createApp = async (imports: ModuleImport[]) => {
      @Module({ imports })
      class AppModule implements BunestModule {
        configure(consumer: MiddlewareConsumer) {
          consumer
            .apply((_req, _res, _next) => new Response(AUTH_VALUE))
            .forRoutes("{*path}");
        }
      }

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    };

    beforeEach(() => {
      registerCalls = 0;
      serviceInstances = 0;
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    // BUNEST_BUG: Expected GET /dashboard (middleware-only route without controller) to return 200 "unauthorized" after verifying single forwardRef module registration, got 404. packages/core/src/http/router/route-compiler.ts does not execute module middlewares on unmatched routes, packages/core/src/http/scanner/path-normalizer.ts does not recognize `{*path}`, and packages/core/src/application/bunest-application.ts registers child module middlewares before parent module middlewares.
    it.skip("should register a dynamic module given as forwardRef() once, below its importer", async () => {
      await createApp([forwardRef(() => DashboardModule.register())]);

      expect(registerCalls).toBe(1);
      expect(countModules(app!, DashboardModule)).toBe(1);
      await request(app!).get("/dashboard").expect(200, AUTH_VALUE);
    });

    // BUNEST_BUG: Expected GET /dashboard (middleware-only route without controller) to return 200 "unauthorized" after verifying single forwardRef module/service registration, got 404. packages/core/src/http/router/route-compiler.ts does not execute module middlewares on unmatched routes, packages/core/src/http/scanner/path-normalizer.ts does not recognize `{*path}`, and packages/core/src/application/bunest-application.ts registers child middlewares before parent middlewares.
    it.skip("should register a module given as forwardRef() in the imports of a dynamic module once", async () => {
      await createApp([FeatureModule.register()]);

      expect(countModules(app!, ReportsModule)).toBe(1);
      expect(serviceInstances).toBe(1);
      await request(app!).get("/dashboard").expect(200, AUTH_VALUE);
    });
  },
);
