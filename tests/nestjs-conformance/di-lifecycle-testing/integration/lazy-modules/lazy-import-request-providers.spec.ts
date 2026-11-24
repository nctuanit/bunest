import { afterEach, beforeEach, expect } from "bun:test";
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
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

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

@Injectable({ scope: Scope.REQUEST })
class RequestService {
  constructor(private readonly eagerService: EagerService) {}

  eager() {
    return this.eagerService.sayHello();
  }
}

@Module({
  providers: [RequestService, GlobalService, EagerService],
  exports: [RequestService],
})
class RequestLazyModule {}

@Controller("lazy")
class LazyController {
  constructor(private readonly lazyLoadModule: LazyModuleLoader) {}

  @Get("request")
  async execRequestScope() {
    const moduleRef = await this.lazyLoadModule.load(() => RequestLazyModule);
    const service = await moduleRef.resolve(RequestService);
    return service.eager();
  }
}

describeConformance(
  "Lazy Request-Scoped providers",
  {
    upstreamPath:
      "integration/lazy-modules/e2e/lazy-import-request-providers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
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

    itAdapted(
      "ADR-012",
      "should not recreate singleton dependencies of lazy request-scoped providers across requests",
      async () => {
        const resultOne = await request(app).get("/lazy/request");
        expect(resultOne.text).toBe("Hi! Counter is 1");
        expect(resultOne.status).toBe(200);

        const resultTwo = await request(app).get("/lazy/request");
        expect(resultTwo.text).toBe("Hi! Counter is 2");
        expect(resultTwo.status).toBe(200);
      },
    );
  },
);
