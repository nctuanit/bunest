import { afterEach, beforeEach, expect, it } from "bun:test";
import { Global, Injectable, Module } from "../../../../../packages/core/src/common";
import {
  LazyModuleLoader,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { Test, describeConformance } from "../../../_helpers";

@Injectable()
class GlobalService {}

@Global()
@Module({
  providers: [GlobalService],
  exports: [GlobalService],
})
class GlobalModule {}

@Injectable()
class EagerService {
  constructor(public readonly globalService: GlobalService) {}
}

@Module({
  providers: [EagerService],
})
class EagerModule {}

@Injectable()
class LazyService {
  constructor(public readonly globalService: GlobalService) {}
}

@Module({
  providers: [LazyService],
})
class LazyModule {}

@Module({
  imports: [GlobalModule, EagerModule],
})
class AppModule {
  constructor(public readonly loader: LazyModuleLoader) {}

  async onApplicationBootstrap() {
    await this.loader.load(() => LazyModule);
  }
}

describeConformance(
  "Lazy imports (global modules)",
  {
    upstreamPath:
      "integration/lazy-modules/e2e/lazy-import-global-modules.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = module.createNestApplication();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should allow lazy modules to inject providers from global modules", async () => {
      await expect(app.init()).resolves.toBeDefined();
    });
  },
);
