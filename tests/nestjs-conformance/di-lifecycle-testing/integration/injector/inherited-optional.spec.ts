import { describe, expect, it } from "bun:test";
import {
  Injectable,
  Module,
  Optional,
  mixin,
} from "../../../../../packages/core/src/common";
import { UnknownDependencyException } from "../../../../../packages/core/src";
import { Test, describeConformance } from "../../../_helpers";

@Injectable()
class NeededService {
  exec() {
    return "exec";
  }
}

@Module({
  providers: [NeededService],
  exports: [NeededService],
})
class NeededModule {}

class FooOptions {}

const Foo = () => {
  class FooMixin {
    constructor(@Optional() readonly options?: FooOptions) {}
  }
  return mixin(FooMixin);
};

@Injectable()
class FooService extends Foo() {
  constructor(private readonly neededService: NeededService) {
    super();
  }

  doSomething() {
    return this.neededService.exec();
  }
}

@Module({
  imports: [],
  providers: [FooService],
  exports: [FooService],
})
class FooModule {}

@Injectable()
class InheritedFooService extends Foo() {}

describeConformance(
  "Inherited optional dependency",
  {
    upstreamPath: "integration/injector/e2e/inherited-optional.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("when the parent has an @Optional() parameter", () => {
      it("should throw an UnknownDependencyException due to the missing dependency", async () => {
        const module = Test.createTestingModule({
          imports: [NeededModule, FooModule],
        });

        await expect(module.compile()).rejects.toBeInstanceOf(
          UnknownDependencyException,
        );
      });

      it("should treat the parameter as optional when the child does not redeclare the constructor", async () => {
        const module = await Test.createTestingModule({
          providers: [InheritedFooService],
        }).compile();

        const service = module.get(InheritedFooService);
        expect(service).toBeInstanceOf(InheritedFooService);
        expect(service.options).toBeUndefined();
        await module.close();
      });

      it("should inject the dependency when the child does not redeclare the constructor and it is available", async () => {
        const module = await Test.createTestingModule({
          providers: [InheritedFooService, FooOptions],
        }).compile();

        expect(module.get(InheritedFooService).options).toBeInstanceOf(
          FooOptions,
        );
        await module.close();
      });
    });
  },
);
