import { describe, expect, it } from "bun:test";
import { AsyncContext } from "../../../../../packages/messaging/src/cqrs";
import { describeConformance } from "../../../_helpers";

class MyRequest extends AsyncContext {
  constructor(public readonly user: string) {
    super();
  }
}

class HeroKilledDragonEvent {}

class DropAncientItemCommand {}

describeConformance(
  "AsyncContext",
  {
    upstreamPath: "nestjs/cqrs/src/scopes/async.context.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("merge()", () => {
      it("should copy the context attached to the source object", () => {
        const request = new MyRequest("alice");
        const event = new HeroKilledDragonEvent();
        const command = new DropAncientItemCommand();
        request.attachTo(event);

        AsyncContext.merge(event, command);

        expect(AsyncContext.of(command)).toBe(request);
      });

      it("should attach the source when it is an async context itself", () => {
        const request = new MyRequest("alice");
        const event = new HeroKilledDragonEvent();
        const command = new DropAncientItemCommand();
        request.attachTo(event);

        AsyncContext.merge(AsyncContext.of(event), command);

        expect(AsyncContext.of(command)).toBe(request);
      });

      it("should do nothing when the source has no context", () => {
        const event = new HeroKilledDragonEvent();
        const command = new DropAncientItemCommand();

        AsyncContext.merge(AsyncContext.of(event), command);

        expect(AsyncContext.isAttached(command)).toBe(false);
      });
    });
  },
);
