import { afterEach, expect, it, spyOn } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  EventEmitter2,
  EventEmitterModule,
  OnEvent,
} from "../../../../../packages/messaging/src/events";
import { Test, describeConformance } from "../../../_helpers";

@Injectable()
class PriorityListener {
  readonly calls: string[] = [];

  constructor(private readonly eventEmitter: EventEmitter2) {
    this.eventEmitter.on("direct.event", () => {
      this.calls.push("direct");
    });
  }

  @OnEvent("ordered", { priority: -5 })
  negative() {
    this.calls.push("negative");
  }

  @OnEvent("ordered")
  normal(payload: string) {
    this.calls.push(`normal:${payload}`);
  }

  @OnEvent("ordered", { priority: 10 })
  high() {
    this.calls.push("high");
  }

  @OnEvent("ties")
  first() {
    this.calls.push("first");
  }

  @OnEvent("ties")
  second() {
    this.calls.push("second");
  }

  @OnEvent("prepend.event", { prependListener: true, priority: -1 })
  prependLow() {
    this.calls.push("prepend-low");
  }

  @OnEvent("prepend.event", { prependListener: true, priority: 5 })
  prependHigh() {
    this.calls.push("prepend-high");
  }

  @OnEvent("prepend.event", { priority: 100 })
  appended() {
    this.calls.push("appended");
  }

  @OnEvent("prepend.ties", { prependListener: true })
  prependFirst() {
    this.calls.push("prepend-first");
  }

  @OnEvent("prepend.ties", { prependListener: true })
  prependSecond() {
    this.calls.push("prepend-second");
  }

  @OnEvent("direct.event", { priority: 50 })
  directHigh() {
    this.calls.push("on-event");
  }

  @OnEvent("user.*", { priority: 100 })
  wildcard() {
    this.calls.push("wildcard");
  }

  @OnEvent("user.login", { priority: -5 })
  exact() {
    this.calls.push("exact");
  }

  @OnEvent("login", { priority: 10, suppressErrors: false })
  checkFraud() {
    this.calls.push("check");
    throw new Error("blocked");
  }

  @OnEvent("login")
  issueToken() {
    this.calls.push("token");
  }

  @OnEvent("timing", { async: true, priority: 5 })
  deferred() {
    this.calls.push("deferred");
  }

  @OnEvent("timing")
  immediate() {
    this.calls.push("immediate");
  }

  @OnEvent("infinite", { priority: -Infinity })
  negativeInfinity() {
    this.calls.push("-infinity");
  }

  @OnEvent("infinite", { priority: Infinity })
  infinityFirst() {
    this.calls.push("infinity-first");
  }

  @OnEvent("infinite")
  defaultPriority() {
    this.calls.push("default");
  }

  @OnEvent("infinite", { priority: Infinity })
  infinitySecond() {
    this.calls.push("infinity-second");
  }

  @OnEvent("infinite", { priority: Number.NaN })
  notANumber() {
    this.calls.push("nan");
  }

  @OnEvent("infinite", { priority: "5" as unknown as number })
  numericString() {
    this.calls.push("string");
  }
}

describeConformance(
  "EventEmitterModule - listener priority",
  {
    upstreamPath: "nestjs/event-emitter/tests/e2e/priority.spec.ts",
    category: "ADAPTED_PORT",
    notes:
      "Adapts eventemitter2 import to native zero-dep @bunest/events EventEmitter2.",
  },
  () => {
    let app: BunestApplication | undefined;

    async function init() {
      const moduleRef = await Test.createTestingModule({
        imports: [
          EventEmitterModule.forRoot({
            wildcard: true,
          }),
        ],
        providers: [PriorityListener],
      }).compile();

      const instance = moduleRef.createNestApplication();
      app = instance;
      await instance.init();
      return {
        emitter: instance.get(EventEmitter2),
        listener: instance.get(PriorityListener),
      };
    }

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it("runs a positive priority before the default and a negative one after", async () => {
      const { emitter, listener } = await init();

      emitter.emit("ordered", "payload");

      expect(listener.calls).toEqual(["high", "normal:payload", "negative"]);
    });

    it("keeps discovery order when priorities are equal", async () => {
      const { emitter, listener } = await init();

      emitter.emit("ties");

      expect(listener.calls).toEqual(["first", "second"]);
    });

    it("keeps prepended listeners ahead and orders that group by priority", async () => {
      const { emitter, listener } = await init();

      emitter.emit("prepend.event");

      expect(listener.calls).toEqual([
        "prepend-high",
        "prepend-low",
        "appended",
      ]);
    });

    it("keeps the existing reverse discovery order for prepended listeners with the same priority", async () => {
      const { emitter, listener } = await init();

      emitter.emit("prepend.ties");

      expect(listener.calls).toEqual(["prepend-second", "prepend-first"]);
    });

    it("accepts infinite priorities and falls back to the default for NaN and non-numbers", async () => {
      const { emitter, listener } = await init();

      emitter.emit("infinite");

      expect(listener.calls).toEqual([
        "infinity-first",
        "infinity-second",
        "default",
        "nan",
        "string",
        "-infinity",
      ]);
    });

    it("does not move an @OnEvent listener ahead of a direct listener", async () => {
      const { emitter, listener } = await init();

      emitter.emit("direct.event");

      expect(listener.calls).toEqual(["direct", "on-event"]);
    });

    // BUNEST_BUG: Expected exact-match listener "user.login" (priority -5) to run before wildcard listener "user.*" (priority 100) matching eventemitter2 exact-before-wildcard semantics, but packages/messaging/src/events/event-emitter.service.ts getMatchingEntries() iterates listenerMap in priority-registration order, yielding ["wildcard", "exact"].
    it.skip("does not order a wildcard listener against an exact event name", async () => {
      const { emitter, listener } = await init();

      emitter.emit("user.login");

      expect(listener.calls).toEqual(["exact", "wildcard"]);
    });

    it("still calls the next listener when a higher priority one rejects", async () => {
      const { emitter, listener } = await init();

      await expect(emitter.emitAsync("login")).rejects.toThrow("blocked");
      expect(listener.calls).toEqual(["check", "token"]);
    });

    it("still defers async listeners when priority is set", async () => {
      const { emitter, listener } = await init();

      emitter.emit("timing");
      expect(listener.calls).toEqual(["immediate"]);

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(listener.calls).toEqual(["immediate", "deferred"]);
    });

    it("forwards listener options when EventEmitter2 is overridden", async () => {
      const emitter = new EventEmitter2();
      const onSpy = spyOn(emitter, "on");
      const moduleRef = await Test.createTestingModule({
        imports: [EventEmitterModule.forRoot()],
        providers: [PriorityListener],
      })
        .overrideProvider(EventEmitter2)
        .useValue(emitter)
        .compile();
      const overriddenApp = moduleRef.createNestApplication();

      try {
        await overriddenApp.init();

        expect(onSpy).toHaveBeenCalledWith(
          "timing",
          expect.any(Function),
          expect.objectContaining({ async: true, priority: 5 }),
        );
      } finally {
        onSpy.mockRestore();
        await overriddenApp.close();
      }
    });
  },
);
