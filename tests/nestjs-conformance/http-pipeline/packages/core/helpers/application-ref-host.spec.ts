import "reflect-metadata";
import { beforeEach, expect, it } from "bun:test";
import { HttpAdapterHost } from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "HttpAdapterHost (application-ref-host)",
  {
    upstreamPath: "packages/core/test/helpers/application-ref-host.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Upstream application-ref-host.spec.ts tests HttpAdapterHost (neither NestJS v12 nor Bunest exports ApplicationRefHost). Adapted listen$ RxJS Observable -> onListen() callback per ADR-008.",
  },
  () => {
    let applicationRefHost: HttpAdapterHost;

    beforeEach(() => {
      applicationRefHost = new HttpAdapterHost();
    });

    it("should wrap application reference", () => {
      const ref = {};
      applicationRefHost.httpAdapter = ref as never;

      expect(applicationRefHost.httpAdapter).toEqual(ref as never);
    });

    itAdapted(
      "ADR-008",
      "should emit listen event when listening is set to true",
      async () => {
        await new Promise<void>((resolve) => {
          applicationRefHost.onListen(() => {
            expect(applicationRefHost.listening).toBe(true);
            resolve();
          });
          applicationRefHost.listening = true;
        });
      },
      "onListen() callback replaces RxJS listen$",
    );

    it("listening should return false if the application isnt listening yet", () => {
      expect(applicationRefHost.listening).toBe(false);
    });
  },
);
