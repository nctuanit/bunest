import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  ModuleScanner,
  ROUTER_MODULE_ROUTES,
  RouterModule,
  resolveRouterModulePrefixes,
  type Routes,
} from "../../../../../../packages/core/src";
import { describeConformance } from "../../../../_helpers";

@Controller("items")
class TestController {
  @Get()
  list() {
    return ["a"];
  }
}

@Module({ controllers: [TestController] })
class TestModuleClass {}

describeConformance(
  "RouterModule",
  {
    upstreamPath: "packages/core/test/router/router-module.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    const routes: Routes = [{ path: "test", module: TestModuleClass }];

    describe("register", () => {
      it("should return a dynamic module with routes registered as a provider", () => {
        expect(RouterModule.register(routes)).toEqual({
          module: RouterModule,
          providers: [
            {
              provide: ROUTER_MODULE_ROUTES,
              useValue: routes,
            },
          ],
        });
      });
    });

    describe("when scanned in a module graph", () => {
      it("should resolve prefixes for registered target modules and ignore unregistered modules", async () => {
        @Module({})
        class NotRegisteredModuleClass {}

        @Module({
          imports: [
            TestModuleClass,
            RouterModule.register(routes),
            RouterModule.register([
              {
                path: "random",
                module: NotRegisteredModuleClass,
              },
            ]),
          ],
        })
        class AppModule {}

        const graph = await new ModuleScanner().scan(AppModule);
        const controllerPrefixes = resolveRouterModulePrefixes(graph);

        expect(controllerPrefixes.get(TestController)).toEqual(["/test"]);
        expect(controllerPrefixes.size).toBe(1);
      });
    });
  },
);
