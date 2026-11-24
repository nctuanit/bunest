import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Global,
  Module,
  forwardRef,
  type DynamicModule,
  type Type,
} from "../../../../../packages/core/src/common";
import {
  BunestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  ApiOkResponse,
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";

class GlobalResponse {
  @ApiProperty()
  value!: string;
}

@Controller("explicit-static-global")
class ExplicitStaticGlobalController {
  @Get()
  @ApiOkResponse({ type: GlobalResponse })
  get() {
    return "explicit static global";
  }
}

@Global()
@Module({ controllers: [ExplicitStaticGlobalController] })
class ExplicitStaticGlobalModule {}

@Controller("implicit-static-global")
class ImplicitStaticGlobalController {
  @Get()
  get() {
    return "implicit static global";
  }
}

@Global()
@Module({ controllers: [ImplicitStaticGlobalController] })
class ImplicitStaticGlobalModule {}

@Controller("explicit-dynamic-global")
class ExplicitDynamicGlobalController {
  @Get()
  get() {
    return "explicit dynamic global";
  }
}

@Controller("implicit-dynamic-global")
class ImplicitDynamicGlobalController {
  @Get()
  get() {
    return "implicit dynamic global";
  }
}

@Module({})
class DynamicGlobalModule {
  static register(controller: Type<unknown>): DynamicModule {
    return {
      module: DynamicGlobalModule,
      global: true,
      controllers: [controller],
    };
  }
}

@Controller("ordinary")
class OrdinaryController {
  @Get()
  get() {
    return "ordinary import";
  }
}

@Module({ controllers: [OrdinaryController] })
class OrdinaryModule {}

@Controller("forward-reference")
class ForwardReferenceController {
  @Get()
  get() {
    return "forward reference import";
  }
}

@Module({ controllers: [ForwardReferenceController] })
class ForwardReferenceModule {}

@Controller("selected")
class SelectedController {
  @Get()
  get() {
    return "selected module";
  }
}

@Module({
  imports: [
    ExplicitStaticGlobalModule,
    DynamicGlobalModule.register(ExplicitDynamicGlobalController),
    OrdinaryModule,
    forwardRef(() => ForwardReferenceModule),
  ],
  controllers: [SelectedController],
})
class SelectedModule {}

@Module({
  imports: [
    ImplicitStaticGlobalModule,
    DynamicGlobalModule.register(ImplicitDynamicGlobalController),
  ],
})
class SiblingModule {}

@Module({})
class DynamicSelectedModule {
  static register(): DynamicModule {
    return {
      module: DynamicSelectedModule,
      imports: [forwardRef(() => ExplicitStaticGlobalModule)],
    };
  }
}

@Module({
  imports: [
    Promise.resolve(
      DynamicGlobalModule.register(ExplicitDynamicGlobalController),
    ),
  ],
})
class AsyncSelectedModule {}

@Module({
  imports: [
    SelectedModule,
    SiblingModule,
    DynamicSelectedModule.register(),
    AsyncSelectedModule,
  ],
})
class RootModule {}

@Controller("configured-global")
class ConfiguredGlobalController {
  @Get()
  get() {
    return "configured global";
  }
}

const configuredGlobalOptions: Record<string, unknown> = { url: "initial" };

@Module({})
class ConfiguredGlobalModule {
  static forRoot(): DynamicModule {
    return {
      module: ConfiguredGlobalModule,
      global: true,
      controllers: [ConfiguredGlobalController],
      providers: [{ provide: "OPTIONS", useValue: configuredGlobalOptions }],
    };
  }
}

@Module({
  imports: [ConfiguredGlobalModule.forRoot()],
  controllers: [SelectedController],
})
class ConfiguredSelectedModule {}

@Module({ imports: [ConfiguredSelectedModule] })
class ConfiguredRootModule {}

@Controller("forward-promise-global")
class ForwardPromiseGlobalController {
  @Get()
  get() {
    return "forward promise global";
  }
}

@Module({})
class ForwardPromiseGlobalModule {}

const forwardPromiseGlobal = Promise.resolve<DynamicModule>({
  module: ForwardPromiseGlobalModule,
  global: true,
  controllers: [ForwardPromiseGlobalController],
});

@Module({
  imports: [forwardRef(() => forwardPromiseGlobal as any)],
  controllers: [SelectedController],
})
class ForwardPromiseSelectedModule {}

@Module({ imports: [ForwardPromiseSelectedModule] })
class ForwardPromiseRootModule {}

describeConformance(
  "Swagger deep scan global modules",
  {
    upstreamPath: "e2e/deep-scan-global-modules.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestFactory.create to BunestFactory.create (ADR-001) testing SwaggerModule.createDocument({ include, deepScanRoutes }).",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      app = await BunestFactory.create(RootModule, { logger: false });
    });

    afterEach(async () => {
      await app.close();
    });

    it("retains directly declared globals and excludes globals bound by Nest", () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("Deep scan").setVersion("1").build(),
        { include: [SelectedModule], deepScanRoutes: true },
      );

      expect(document.components?.schemas?.GlobalResponse).toBeDefined();
      const response = document.paths["/explicit-static-global"]?.get
        ?.responses["200"] as any;
      expect(response.content["application/json"].schema.$ref).toBe(
        "#/components/schemas/GlobalResponse",
      );
      expect(Object.keys(document.paths).sort()).toEqual([
        "/explicit-dynamic-global",
        "/explicit-static-global",
        "/forward-reference",
        "/ordinary",
        "/selected",
      ]);
    });

    // BUNEST_BUG: resolveRoutesForDocument (packages/swagger/src/swagger-module.ts:215) defaults deepScanRoutes to true (`!== false`) instead of NestJS default false, causing shallow scans to include imported module routes
    it.skip("preserves shallow scans", () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
        { include: [SelectedModule] },
      );
      expect(Object.keys(document.paths)).toEqual(["/selected"]);
    });

    it("retains an explicitly included global root", () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
        { include: [ExplicitStaticGlobalModule], deepScanRoutes: true },
      );
      expect(Object.keys(document.paths)).toEqual(["/explicit-static-global"]);
    });

    it("reads dynamic parent imports and resolves global forward references", () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
        { include: [DynamicSelectedModule], deepScanRoutes: true },
      );
      expect(Object.keys(document.paths)).toEqual(["/explicit-static-global"]);
    });

    // BUNEST_BUG: resolveRoutesForDocument (packages/swagger/src/swagger-module.ts:225-248) only walks resolved mod.imports and does not fall back to including global modules when an async dynamic module import cannot be identified synchronously
    it.skip("preserves existing behavior when an async import cannot be identified synchronously", () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
        { include: [AsyncSelectedModule], deepScanRoutes: true },
      );
      expect(Object.keys(document.paths).sort()).toEqual([
        "/explicit-dynamic-global",
        "/explicit-static-global",
        "/implicit-dynamic-global",
        "/implicit-static-global",
      ]);
    });

    describe("Swagger deep scan global modules (imports that cannot be matched)", () => {
      it("keeps a deep-hash global whose metadata changed after bootstrap", async () => {
        const localApp = await BunestFactory.create(ConfiguredRootModule, {
          logger: false,
          moduleIdGeneratorAlgorithm: "deep-hash",
        });
        try {
          configuredGlobalOptions.url = "changed at runtime";
          const document = SwaggerModule.createDocument(
            localApp,
            new DocumentBuilder().build(),
            { include: [ConfiguredSelectedModule], deepScanRoutes: true },
          );
          expect(Object.keys(document.paths).sort()).toEqual([
            "/configured-global",
            "/selected",
          ]);
        } finally {
          configuredGlobalOptions.url = "initial";
          await localApp.close();
        }
      });

      it("keeps a global imported through a forward reference to a promise", async () => {
        const localApp = await BunestFactory.create(ForwardPromiseRootModule, {
          logger: false,
        });
        try {
          const document = SwaggerModule.createDocument(
            localApp,
            new DocumentBuilder().build(),
            { include: [ForwardPromiseSelectedModule], deepScanRoutes: true },
          );
          expect(Object.keys(document.paths).sort()).toEqual([
            "/forward-promise-global",
            "/selected",
          ]);
        } finally {
          await localApp.close();
        }
      });
    });
  },
);
