import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Controller, Post } from "../../../../../../packages/common/src";
import {
  ApiWebhook,
  DECORATORS,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ApiWebhook",
  {
    upstreamPath: "test/decorators/api-webhook.decorator.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("when applied on the method level", () => {
      @Controller()
      class TestController {
        @Post()
        @ApiWebhook("stripeEvent")
        public stripe() {
          return true;
        }

        @Post("default")
        @ApiWebhook()
        public defaultWebhook() {
          return true;
        }
      }

      it("should attach metadata with a webhook name", () => {
        const controller = new TestController();
        expect(
          Reflect.hasMetadata(DECORATORS.API_WEBHOOK, controller.stripe),
        ).toBe(true);
        expect(
          Reflect.getMetadata(DECORATORS.API_WEBHOOK, controller.stripe),
        ).toBe("stripeEvent");
      });

      it("should attach metadata with a default marker", () => {
        const controller = new TestController();
        expect(
          Reflect.hasMetadata(
            DECORATORS.API_WEBHOOK,
            controller.defaultWebhook,
          ),
        ).toBe(true);
        expect(
          Reflect.getMetadata(
            DECORATORS.API_WEBHOOK,
            controller.defaultWebhook,
          ),
        ).toBe(true);
      });
    });
  },
);
