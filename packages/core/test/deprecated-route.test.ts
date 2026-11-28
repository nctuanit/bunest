import { describe, expect, it } from "bun:test";
import {
  Controller,
  DeprecatedRoute,
  Get,
  Module,
} from "../src/common/index";
import { BunestFactory } from "../src/index";

describe("@DeprecatedRoute() RFC 8594 / RFC 9745 headers", () => {
  @Controller("legacy")
  class LegacyController {
    @Get("users")
    @DeprecatedRoute({
      sunset: "2027-06-01T00:00:00Z",
      link: "/v2/users",
      message: "Migrate to /v2/users before June 2027",
    })
    listUsers() {
      return { users: [] };
    }

    @Get("raw")
    @DeprecatedRoute({
      deprecation: new Date("2026-01-01T00:00:00Z"),
      sunset: new Date("2027-01-01T00:00:00Z"),
    })
    rawResponse() {
      return new Response("legacy-body", { status: 200 });
    }
  }

  @Module({ controllers: [LegacyController] })
  class LegacyModule {}

  it("attaches Deprecation, Sunset (IMF-fixdate), Link, and X-Deprecation-Notice headers", async () => {
    const app = await BunestFactory.create(LegacyModule, { logger: false });
    await app.init();

    try {
      const res = await app.fetch(new Request("http://localhost/legacy/users"));
      expect(res.status).toBe(200);
      expect(res.headers.get("deprecation")).toBe("true");
      expect(res.headers.get("sunset")).toBe("Tue, 01 Jun 2027 00:00:00 GMT");
      expect(res.headers.get("link")).toBe('</v2/users>; rel="successor-version"');
      expect(res.headers.get("x-deprecation-notice")).toBe(
        "Migrate to /v2/users before June 2027",
      );
      expect(await res.json()).toEqual({ users: [] });

      const resRaw = await app.fetch(new Request("http://localhost/legacy/raw"));
      expect(resRaw.status).toBe(200);
      expect(resRaw.headers.get("deprecation")).toBe(
        `@${Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000)}`,
      );
      expect(resRaw.headers.get("sunset")).toBe("Fri, 01 Jan 2027 00:00:00 GMT");
      expect(await resRaw.text()).toBe("legacy-body");
    } finally {
      await app.close();
    }
  });

  it("rejects CR/LF header injection in link/message/deprecation", () => {
    expect(() =>
      DeprecatedRoute({ link: "/v2\r\nX-Evil: 1" }),
    ).toThrow("CR/LF");
    expect(() =>
      DeprecatedRoute({ message: "bad\nheader" }),
    ).toThrow("CR/LF");
  });
});
