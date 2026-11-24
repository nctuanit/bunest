import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  APP_INTERCEPTOR,
  Controller,
  Module,
  Sse,
  type MessageEvent,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CacheInterceptor,
  CacheModule,
} from "../../../../../packages/cache/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers/index";

const getEventData = (text: string) =>
  text.match(/^data: .*$/gm)?.map((line) => line.slice("data: ".length));

@Controller()
class SseController {
  counter = 0;

  @Sse("events")
  async *events(): AsyncGenerator<MessageEvent> {
    const run = this.counter++;
    yield { data: `${run}-1` };
    yield { data: `${run}-2` };
    yield { data: `${run}-3` };
  }
}

@Module({
  imports: [CacheModule.register()],
  controllers: [SseController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInterceptor,
    },
  ],
})
class SseModule {}

describeConformance(
  "CacheInterceptor - Server-sent events",
  {
    upstreamPath: "cache-manager/tests/e2e/sse.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts RxJS Observable @Sse() handler to Bunest AsyncGenerator SSE (ADR-008) and zero-socket request(app) (ADR-001).",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [SseModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should not cache server-sent event streams",
      async () => {
        const first = await request(app).get("/events").expect(200);
        const second = await request(app).get("/events").expect(200);

        expect(getEventData(first.text)).toEqual(["0-1", "0-2", "0-3"]);
        expect(getEventData(second.text)).toEqual(["1-1", "1-2", "1-3"]);
      },
    );

    afterEach(async () => {
      await app.close();
    });
  },
);
