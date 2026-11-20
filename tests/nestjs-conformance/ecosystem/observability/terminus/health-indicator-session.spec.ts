import "reflect-metadata";
import { beforeEach, describe, expect, it } from "bun:test";
import { HealthIndicatorSession } from "../../../../../packages/observability/src";
import { describeConformance } from "../../../_helpers/index";

describeConformance(
  "HealthIndicatorSession",
  {
    upstreamPath:
      "terminus/lib/health-indicator/service/health-indicator-session.spec.ts",
    category: "DIRECT_PORT",
    notes: "Direct port of upstream @nestjs/terminus HealthIndicatorSession unit tests.",
  },
  () => {
    let session: HealthIndicatorSession<"test">;

    beforeEach(() => {
      session = new HealthIndicatorSession("test");
    });

    describe("up", () => {
      it("should return an up result", () => {
        expect(session.up()).toEqual({ test: { status: "up" } });
      });

      it("should return an up result with additional data", () => {
        expect(session.up({ foo: "bar" })).toEqual({
          test: { status: "up", foo: "bar" },
        });
      });

      it("should return an up result with a message string", () => {
        expect(session.up("hello")).toEqual({
          test: { status: "up", message: "hello" },
        });
      });

      it("should throw if status is used as additional data key", () => {
        expect(() => session.up({ status: "foo" } as any)).toThrow(
          '"status" is a reserved key',
        );
      });

      it("should allow responseTime as additional data key (only reserved within attempt)", () => {
        expect(session.up({ responseTime: 5 })).toEqual({
          test: { status: "up", responseTime: 5 },
        });
      });
    });

    describe("degraded", () => {
      it("should return a degraded result", () => {
        expect(session.degraded()).toEqual({ test: { status: "degraded" } });
      });

      it("should return a degraded result with a message string", () => {
        expect(session.degraded("slow")).toEqual({
          test: { status: "degraded", message: "slow" },
        });
      });
    });

    describe("down", () => {
      it("should return a down result", () => {
        expect(session.down()).toEqual({ test: { status: "down" } });
      });

      it("should return a down result with additional data", () => {
        expect(session.down({ reason: "timeout" })).toEqual({
          test: { status: "down", reason: "timeout" },
        });
      });

      it("should return a down result with a message string", () => {
        expect(session.down("broken")).toEqual({
          test: { status: "down", message: "broken" },
        });
      });
    });
  },
);
