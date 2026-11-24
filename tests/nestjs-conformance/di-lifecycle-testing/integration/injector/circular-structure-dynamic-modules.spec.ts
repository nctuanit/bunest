import { expect, it } from "bun:test";
import {
  Injectable,
  type DynamicModule,
} from "../../../../../packages/core/src/common";
import { Test, describeConformance } from "../../../_helpers";

@Injectable()
class InputService {}

class CircularModule {
  static forRoot(): DynamicModule {
    const a: DynamicModule & { b: unknown } = {
      module: CircularModule,
      providers: [InputService],
      b: null,
    };
    a.b = a;
    return a;
  }
}

describeConformance(
  "Circular structure for dynamic modules",
  {
    upstreamPath:
      "integration/injector/e2e/circular-structure-dynamic-modules.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should resolve circular structure with dynamic modules", async () => {
      const builder = Test.createTestingModule({
        imports: [CircularModule.forRoot()],
      });
      const testingModule = await builder.compile();
      const inputService = testingModule.get<InputService>(InputService);

      expect(inputService).toBeInstanceOf(InputService);
      await testingModule.close();
    });
  },
);
