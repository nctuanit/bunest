import { describe, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  Optional,
} from "../../../../../packages/core/src/common";
import { Test, describeConformance } from "../../../_helpers";

@Injectable()
class CoreService {}

@Injectable()
class DefaultsService {
  constructor(
    @Inject(CoreService)
    @Optional()
    public readonly coreService = { default: true },
  ) {}
}

@Module({
  providers: [DefaultsService],
})
class DefaultsModule {}

describeConformance(
  "Injector (default values)",
  {
    upstreamPath: "integration/injector/e2e/default-values.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("when optional", () => {
      it("should make use of default assignments", async () => {
        const builder = Test.createTestingModule({
          imports: [DefaultsModule],
        });
        const app = await builder.compile();
        expect(app.get(DefaultsService).coreService.default).toBe(true);
        await app.close();
      });
    });
  },
);
