import { expect, it } from "bun:test";
import {
  Controller,
  Inject,
  Injectable,
  Module,
} from "../../../../../packages/core/src/common";
import { CircularDependencyException } from "../../../../../packages/core/src";
import { Test, describeConformance } from "../../../_helpers";

class B {}

const ALIAS = "ALIAS";

@Injectable()
class Third {
  constructor(@Inject(ALIAS) public readonly first: object) {}
}

@Injectable()
class Second {
  constructor(public readonly third: Third) {}
}

@Injectable()
class First {
  constructor(public readonly second: Second) {}
}

@Injectable()
class A {
  constructor(public readonly b: B) {}
}

@Injectable()
class BImpl {
  constructor(public readonly a: A) {}
}

@Controller()
class AppController {
  constructor(public readonly a: A) {}
}

@Module({
  imports: [],
  controllers: [AppController],
  providers: [A, { provide: B, useClass: BImpl }],
})
class AppModule {}

describeConformance(
  "Circular custom providers",
  {
    upstreamPath: "integration/injector/e2e/circular-custom-providers.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should throw an exception (useClass + regular provider)", async () => {
      const builder = Test.createTestingModule({
        imports: [AppModule],
      });
      await expect(builder.compile()).rejects.toBeInstanceOf(
        CircularDependencyException,
      );
    });

    it("should throw an exception (2 factories)", async () => {
      const builder = Test.createTestingModule({
        providers: [
          { provide: "ABC", useFactory: () => ({}), inject: ["DEF"] },
          { provide: "DEF", useFactory: () => ({}), inject: ["ABC"] },
        ],
      });
      await expect(builder.compile()).rejects.toBeInstanceOf(
        CircularDependencyException,
      );
    });

    it("should throw an exception (3 factories)", async () => {
      const builder = Test.createTestingModule({
        providers: [
          { provide: "ABC", useFactory: () => ({}), inject: ["DEF"] },
          { provide: "DEF", useFactory: () => ({}), inject: ["GHI"] },
          { provide: "GHI", useFactory: () => ({}), inject: ["ABC"] },
        ],
      });
      await expect(builder.compile()).rejects.toBeInstanceOf(
        CircularDependencyException,
      );
    });

    it("should throw an exception (3 classes closed by a useExisting alias)", async () => {
      const builder = Test.createTestingModule({
        providers: [
          First,
          Second,
          Third,
          { provide: ALIAS, useExisting: First },
        ],
      });
      await expect(builder.compile()).rejects.toBeInstanceOf(
        CircularDependencyException,
      );
    });

    it("should not throw when two providers share a dependency", async () => {
      const builder = Test.createTestingModule({
        providers: [
          { provide: "TOP", useFactory: () => ({}), inject: ["LEFT", "RIGHT"] },
          { provide: "LEFT", useFactory: () => ({}), inject: ["BOTTOM"] },
          { provide: "RIGHT", useFactory: () => ({}), inject: ["BOTTOM"] },
          { provide: "BOTTOM", useFactory: () => ({}) },
        ],
      });
      const mod = await builder.compile();
      expect(mod).toBeDefined();
      await mod.close();
    });
  },
);
