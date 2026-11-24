import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Scope,
} from "../../../../../packages/core/src/common";
import {
  LazyModuleLoader,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

@Injectable()
class GlobalService {}

@Injectable()
class EagerService {
  private counter = 0;
  constructor(public readonly globalService: GlobalService) {}

  sayHello() {
    this.counter++;
    return "Hi! Counter is " + this.counter;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientService {
  constructor(private readonly eagerService: EagerService) {}

  eager() {
    return this.eagerService.sayHello();
  }
}

@Module({
  providers: [TransientService, GlobalService, EagerService],
  exports: [TransientService],
})
class TransientLazyModule {}

@Controller("lazy")
class LazyController {
  constructor(private readonly lazyLoadModule: LazyModuleLoader) {}

  @Get("transient")
  async exec() {
    const moduleRef = await this.lazyLoadModule.load(() => TransientLazyModule);
    const service = await moduleRef.resolve(TransientService);
    return service.eager();
  }
}

describeConformance(
  "Lazy Transient providers",
  {
    upstreamPath:
      "integration/lazy-modules/e2e/lazy-import-transient-providers.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        controllers: [LazyController],
      }).compile();

      app = module.createNestApplication();
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should not recreate singleton dependencies for lazy transient providers", async () => {
      const resultOne = await request(app).get("/lazy/transient");
      const resultTwo = await request(app).get("/lazy/transient");

      expect(resultOne.text).toBe("Hi! Counter is 1");
      expect(resultOne.status).toBe(200);

      expect(resultTwo.text).toBe("Hi! Counter is 2");
      expect(resultTwo.status).toBe(200);
    });
  },
);
