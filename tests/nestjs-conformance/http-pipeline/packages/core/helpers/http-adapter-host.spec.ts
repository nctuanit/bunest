import { beforeEach, describe, expect, it } from "bun:test";
import {
  BunHttpAdapter,
  HttpAdapterHost,
} from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "HttpAdapterHost",
  {
    upstreamPath: "packages/core/test/helpers/http-adapter-host.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts RxJS init$/listen$ Observables to Bunest's zero-RxJS onInit()/onListen() callbacks (ADR-008) and BunHttpAdapter (ADR-001).",
  },
  () => {
    let host: HttpAdapterHost;

    beforeEach(() => {
      host = new HttpAdapterHost();
    });

    describe("httpAdapter accessors", () => {
      it("should return undefined when no adapter is set", () => {
        expect(host.httpAdapter).toBeUndefined();
      });

      itAdapted(
        "ADR-001",
        "should store and retrieve the adapter",
        () => {
          const adapter = new BunHttpAdapter({ logger: false });
          host.httpAdapter = adapter;

          expect(host.httpAdapter).toBe(adapter);
        },
        "BunHttpAdapter instead of Express adapter",
      );
    });

    describe("onInit (ADR-008 replacement for init$)", () => {
      itAdapted(
        "ADR-008",
        "should emit when markInitialized() is called",
        async () => {
          const promise = new Promise<void>((resolve) => {
            host.onInit(() => resolve());
          });

          host.httpAdapter = new BunHttpAdapter({ logger: false });
          host.markInitialized();

          await expect(promise).resolves.toBeUndefined();
        },
        "onInit() callback",
      );

      itAdapted(
        "ADR-008",
        "should replay to late subscribers after markInitialized()",
        async () => {
          host.httpAdapter = new BunHttpAdapter({ logger: false });
          host.markInitialized();

          let called = false;
          const result = await new Promise<undefined>((resolve) => {
            host.onInit(() => {
              called = true;
              resolve(undefined);
            });
          });
          expect(called).toBe(true);
          expect(result).toBeUndefined();
        },
        "onInit() immediate replay",
      );

      it("should emit when httpAdapter is set directly without calling markInitialized() [ADR-008: upstream init$ emits inside httpAdapter setter]", async () => {
        let emitted = false;
        host.onInit(() => {
          emitted = true;
        });

        host.httpAdapter = new BunHttpAdapter({ logger: false });

        expect(emitted).toBe(true);
      });

      it("should allow unsubscribing from onInit before initialization", () => {
        let count = 0;
        const unsubscribe = host.onInit(() => {
          count += 1;
        });
        unsubscribe();

        host.markInitialized();
        expect(count).toBe(0);
      });
    });

    describe("listening accessors", () => {
      it("should default to false", () => {
        expect(host.listening).toBe(false);
      });

      it("should update when set to true", () => {
        host.listening = true;
        expect(host.listening).toBe(true);
      });
    });

    describe("onListen (ADR-008 replacement for listen$)", () => {
      itAdapted(
        "ADR-008",
        "should emit when listening is set to true",
        async () => {
          const promise = new Promise<undefined>((resolve) => {
            host.onListen(() => resolve(undefined));
          });

          host.listening = true;

          await expect(promise).resolves.toBeUndefined();
        },
        "onListen() callback",
      );

      itAdapted(
        "ADR-008",
        "should not emit when listening is set to false",
        () => {
          let emitted = false;
          host.onListen(() => {
            emitted = true;
          });

          host.listening = false;

          expect(emitted).toBe(false);
        },
        "onListen() callback",
      );

      it("should replay immediately to late onListen subscribers when already listening", () => {
        host.listening = true;
        let called = false;
        host.onListen(() => {
          called = true;
        });
        expect(called).toBe(true);
      });

      it("should allow unsubscribing from onListen", () => {
        let called = false;
        const unsubscribe = host.onListen(() => {
          called = true;
        });
        unsubscribe();
        host.listening = true;
        expect(called).toBe(false);
      });
    });
  },
);
