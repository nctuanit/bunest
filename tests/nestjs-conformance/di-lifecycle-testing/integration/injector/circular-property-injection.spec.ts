import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  forwardRef,
} from "../../../../../packages/common/src";
import { Test, describeConformance } from "../../../_helpers";

@Injectable()
class CircularService {
  @Inject(forwardRef(() => InputService))
  public readonly service!: unknown;
}

@Injectable()
class InputService {
  @Inject(forwardRef(() => CircularService))
  public readonly service!: unknown;
}

@Module({
  imports: [forwardRef(() => InputPropertiesModule)],
  providers: [CircularService],
  exports: [CircularService],
})
class CircularPropertiesModule {}

@Module({
  imports: [forwardRef(() => CircularPropertiesModule)],
  providers: [InputService],
  exports: [InputService],
})
class InputPropertiesModule {}

describeConformance(
  "Circular properties dependency (modules)",
  {
    upstreamPath:
      "integration/injector/e2e/circular-property-injection.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should resolve circular dependency between providers", async () => {
      const builder = Test.createTestingModule({
        imports: [CircularPropertiesModule, InputPropertiesModule],
      });
      const testingModule = await builder.compile();
      const inputService = testingModule.get<InputService>(InputService);
      const circularService =
        testingModule.get<CircularService>(CircularService);

      expect(inputService.service).toEqual(circularService);
      expect(circularService.service).toEqual(inputService);
      await testingModule.close();
    });
  },
);
