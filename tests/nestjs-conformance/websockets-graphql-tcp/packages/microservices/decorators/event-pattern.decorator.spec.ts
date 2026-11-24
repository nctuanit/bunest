import { describe, expect, it } from "bun:test";
import {
  Controller,
  MetadataRegistry,
} from "../../../../../../packages/core/src/common";
import {
  EVENT_PATTERN_METADATA,
  EventPattern,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  MicroserviceModule,
  Transport,
  type PatternHandlerMetadata,
} from "../../../../../../packages/microservices/src";
import { Test } from "../../../../../../packages/testing/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@EventPattern",
  {
    upstreamPath:
      "packages/microservices/test/decorators/event-pattern.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Tests @EventPattern() metadata registration, canonical pattern normalization, stacking, inheritance safety, and runtime event dispatch.",
  },
  () => {
    const pattern = { role: "test" };
    const patternSecond = { role: "test2" };
    const patternThird = { role: "test3" };
    const extras = { param: "value" };

    class TestComponent {
      @EventPattern(pattern)
      public test() {}

      @EventPattern(patternSecond)
      @EventPattern(patternThird)
      public testStacked() {}

      @EventPattern("user.created")
      public testString() {}

      @EventPattern(/^audit\./)
      public testRegex() {}

      @EventPattern({ b: 2, a: 1 })
      public testCanonical() {}
    }

    it("should enhance class with EVENT_PATTERN_METADATA metadata for object pattern", () => {
      const metadata = MetadataRegistry.getOwn<
        readonly PatternHandlerMetadata[]
      >(EVENT_PATTERN_METADATA, TestComponent);
      const entry = metadata?.find((m) => m.methodName === "test");

      expect(entry).toEqual({
        methodName: "test",
        pattern,
        normalizedPattern: '{"role":"test"}',
        isEventHandler: true,
      });
    });

    it("should support string, RegExp, and canonically sorted object patterns", () => {
      const metadata = MetadataRegistry.getOwn<
        readonly PatternHandlerMetadata[]
      >(EVENT_PATTERN_METADATA, TestComponent);

      expect(metadata?.find((m) => m.methodName === "testString")).toEqual({
        methodName: "testString",
        pattern: "user.created",
        normalizedPattern: "user.created",
        isEventHandler: true,
      });
      expect(metadata?.find((m) => m.methodName === "testRegex")).toEqual({
        methodName: "testRegex",
        pattern: /^audit\./,
        normalizedPattern: "/^audit\\./",
        isEventHandler: true,
      });
      expect(metadata?.find((m) => m.methodName === "testCanonical")).toEqual({
        methodName: "testCanonical",
        pattern: { b: 2, a: 1 },
        normalizedPattern: '{"a":1,"b":2}',
        isEventHandler: true,
      });
    });

    it("should record stacked @EventPattern decorators on the same method", () => {
      const metadata = MetadataRegistry.getOwn<
        readonly PatternHandlerMetadata[]
      >(EVENT_PATTERN_METADATA, TestComponent);
      const entries = (metadata ?? []).filter(
        (m) => m.methodName === "testStacked",
      );

      expect(entries).toHaveLength(2);
      // Decorators execute bottom-up: patternThird then patternSecond
      expect(entries.map((e) => e.pattern)).toEqual([
        patternThird,
        patternSecond,
      ]);
    });

    it("should preserve inheritance-safe copy-on-write metadata between parent and subclass", () => {
      class ParentHandler {
        @EventPattern("parent.evt")
        onParent() {}
      }

      class ChildHandler extends ParentHandler {
        @EventPattern("child.evt")
        onChild() {}
      }

      const parentMeta = MetadataRegistry.getOwn<
        readonly PatternHandlerMetadata[]
      >(EVENT_PATTERN_METADATA, ParentHandler);
      const childMeta = MetadataRegistry.getOwn<
        readonly PatternHandlerMetadata[]
      >(EVENT_PATTERN_METADATA, ChildHandler);

      expect(parentMeta?.map((m) => m.normalizedPattern)).toEqual([
        "parent.evt",
      ]);
      expect(childMeta?.map((m) => m.normalizedPattern)).toEqual(["child.evt"]);
    });

    it("should bind stacked and inherited @EventPattern handlers onto a transport server", async () => {
      const broker = new InMemoryBroker();
      const server = new InMemoryServer({ channel: "evt-dec-test", broker });
      const received: string[] = [];

      class BaseEventController {
        @EventPattern("evt.base")
        onBase(data: string) {
          received.push(`base:${data}`);
        }
      }

      @Controller()
      class ChildEventController extends BaseEventController {
        @EventPattern(patternSecond)
        @EventPattern(patternThird)
        onMulti(data: string) {
          received.push(`multi:${data}`);
        }
      }

      const mod = await Test.createTestingModule({
        imports: [MicroserviceModule.forRoot({ server })],
        controllers: [ChildEventController],
      }).compile();
      await mod.init();

      const client = new InMemoryClientProxy({
        channel: "evt-dec-test",
        broker,
      });

      try {
        await client.emit("evt.base", "one");
        await client.emit(patternSecond, "two");
        await client.emit(patternThird, "three");

        expect(received).toEqual(["base:one", "multi:two", "multi:three"]);
      } finally {
        await client.close();
        await mod.close();
      }
    });

    describe("NestJS decorator overloads & extras (unimplemented parity)", () => {
      // BUNEST_BUG: @EventPattern() in packages/microservices/src/decorators.ts only accepts a single `pattern: PatternInput` parameter; array patterns (`[p1, p2]`) are serialized as JSON array strings instead of registering multiple patterns.
      it.skip("should enhance method with array of patterns passed to @EventPattern([p1, p2])", () => {
        const dynamicEventPattern = EventPattern as (
          ...args: unknown[]
        ) => MethodDecorator;

        class ArrayPatternComponent {
          @dynamicEventPattern([patternSecond, patternThird])
          public testBoth() {}
        }

        const metadata = MetadataRegistry.getOwn<
          readonly PatternHandlerMetadata[]
        >(EVENT_PATTERN_METADATA, ArrayPatternComponent);
        expect(metadata).toHaveLength(2);
        expect(metadata?.[0]?.pattern).toEqual(patternSecond);
        expect(metadata?.[1]?.pattern).toEqual(patternThird);
      });

      // BUNEST_BUG: @EventPattern() in packages/microservices/src/decorators.ts does not support `transport` or `extras` overloads (`EventPattern(pattern, transport?, extras?)`), nor `TRANSPORT_METADATA` / `PATTERN_EXTRAS_METADATA` tokens in packages/microservices/src/tokens.ts.
      it.skip("should enhance method with transport and extras metadata overloads", () => {
        const dynamicEventPattern = EventPattern as (
          ...args: unknown[]
        ) => MethodDecorator;

        class ExtrasComponent {
          @dynamicEventPattern(pattern, Transport.TCP, extras)
          public test() {}
        }

        const metadata = MetadataRegistry.getOwn<
          readonly (PatternHandlerMetadata & {
            transport?: Transport;
            extras?: Record<string, unknown>;
          })[]
        >(EVENT_PATTERN_METADATA, ExtrasComponent);
        expect(metadata?.[0]?.pattern).toEqual(pattern);
        expect(metadata?.[0]?.transport).toBe(Transport.TCP);
        expect(metadata?.[0]?.extras).toEqual(extras);
      });

      // BUNEST_BUG: @EventPattern() in packages/microservices/src/decorators.ts does not merge pre-existing PATTERN_EXTRAS_METADATA metadata.
      it.skip("should merge with existing pattern extras metadata", () => {
        const additionalExtras = { foo: "bar" };
        const dynamicEventPattern = EventPattern as (
          ...args: unknown[]
        ) => MethodDecorator;

        class MergedExtrasComponent {
          @dynamicEventPattern(pattern, Transport.TCP, extras)
          public test() {}
        }

        const metadata = MetadataRegistry.getOwn<
          readonly (PatternHandlerMetadata & {
            extras?: Record<string, unknown>;
          })[]
        >(EVENT_PATTERN_METADATA, MergedExtrasComponent);
        expect(metadata?.[0]?.extras).toEqual({
          ...additionalExtras,
          ...extras,
        });
      });
    });
  },
);
