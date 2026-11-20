import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
} from "../../../../../packages/common/src";
import { UnknownDependencyException } from "../../../../../packages/core/src";
import { Test, describeConformance } from "../../../_helpers";

const SYMBOL_TOKEN = Symbol("token");

@Injectable()
class DependencyService {}

@Injectable()
class PropertiesService {
  @Inject() service!: DependencyService;
  @Inject("token") token!: boolean;
  @Inject(SYMBOL_TOKEN) symbolToken!: boolean;
}

@Module({
  providers: [
    DependencyService,
    PropertiesService,
    {
      provide: "token",
      useValue: true,
    },
    {
      provide: SYMBOL_TOKEN,
      useValue: true,
    },
  ],
})
class PropertiesModule {}

describeConformance(
  "Injector (property injection)",
  {
    upstreamPath: "integration/injector/e2e/property-injection.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should resolve property-based dependencies", async () => {
      const builder = Test.createTestingModule({
        imports: [PropertiesModule],
      });
      const app = await builder.compile();
      const dependency = app.get(DependencyService);

      expect(app.get(PropertiesService).service).toEqual(dependency);
      expect(app.get(PropertiesService).token).toBe(true);
      expect(app.get(PropertiesService).symbolToken).toBe(true);
      await app.close();
    });

    it("should throw UnknownDependencyException when dependency is not met", async () => {
      const builder = Test.createTestingModule({
        providers: [
          DependencyService,
          PropertiesService,
          {
            provide: "token",
            useValue: true,
          },
        ],
      });
      await expect(builder.compile()).rejects.toBeInstanceOf(
        UnknownDependencyException,
      );
    });
  },
);
