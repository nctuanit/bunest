import { expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  forwardRef,
} from "../../../../../packages/core/src/common";
import { Test, describeConformance } from "../../../_helpers";

@Injectable()
class CircularService {
  constructor(
    @Inject(forwardRef(() => InputService))
    public readonly service: unknown,
  ) {}
}

@Injectable()
class InputService {
  constructor(
    @Inject(forwardRef(() => CircularService))
    public readonly service: unknown,
  ) {}
}

@Module({
  providers: [CircularService, InputService],
})
class CircularModule {}

describeConformance(
  "Circular dependency",
  {
    upstreamPath: "integration/injector/e2e/circular.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should resolve circular dependency between providers", async () => {
      const builder = Test.createTestingModule({
        imports: [CircularModule],
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
