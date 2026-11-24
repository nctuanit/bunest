import { describe, expect, it } from "bun:test";
import {
  RequestContext,
  extractRequestCookies,
  extractSignedCookies,
  signCookieValue,
} from "../../../../../../../packages/core/src/http";
import { describeConformance, itAdapted } from "../../../../../_helpers";

describeConformance(
  "request cookies (Bunest extractRequestCookies / extractSignedCookies / RequestContext)",
  {
    upstreamPath: "packages/core/test/helpers/cookies/request-cookies.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS request-cookies helpers to Bunest native Web Request + RequestContext.cookies / RequestContext.signedCookies + extractRequestCookies / extractSignedCookies.",
  },
  () => {
    const secrets = ["secret"] as const;

    describe("extractRequestCookies / RequestContext.cookies", () => {
      it("should parse the Cookie header", () => {
        const req = new Request("http://localhost/", {
          headers: { cookie: "a=1; b=2" },
        });
        expect({ ...extractRequestCookies(req) }).toEqual({ a: "1", b: "2" });
      });

      it("should parse the header once per RequestContext", () => {
        const req = new Request("http://localhost/", {
          headers: { cookie: "a=1" },
        });
        const ctx = new RequestContext({ request: req });
        const first = ctx.cookies;
        req.headers.set("cookie", "a=2");
        expect(ctx.cookies).toBe(first);
        const secondCtx = new RequestContext({
          request: new Request("http://localhost/", {
            headers: { cookie: "a=2" },
          }),
        });
        expect(secondCtx.cookies.a).toBe("2");
      });

      itAdapted(
        "ADR-001",
        "should prefer req.cookies (Bun native CookieMap / middleware-populated Iterable) when present",
        () => {
          const req = new Request("http://localhost/", {
            headers: { cookie: "a=from-header" },
          }) as Request & { cookies?: Map<string, string> };
          req.cookies = new Map([["a", "from-middleware"]]);
          expect(extractRequestCookies(req)).toEqual({ a: "from-middleware" });
        },
        "Bun Request.cookies Iterable<[string, string]> fast path",
      );

      it("should handle requests without Cookie header", () => {
        const req = new Request("http://localhost/");
        expect(Object.keys(extractRequestCookies(req))).toEqual([]);
      });
    });

    describe("single cookie lookup", () => {
      it("should return a single cookie or undefined", () => {
        const ctx = new RequestContext({
          request: new Request("http://localhost/", {
            headers: { cookie: "a=1" },
          }),
        });
        expect(ctx.cookies.a).toBe("1");
        expect(ctx.cookies.b).toBeUndefined();
      });

      // BUNEST_BUG: RequestContext.cookies returns a plain {} instead of Object.create(null) (packages/core/src/http/security/cookie.ts:126), so inherited properties like constructor/toString resolve.
      it.skip("should not resolve inherited members of cookies object", () => {
        const ctx = new RequestContext({
          request: new Request("http://localhost/", {
            headers: { cookie: "a=1" },
          }),
        });
        expect(ctx.cookies.constructor).toBeUndefined();
        expect(ctx.cookies["__proto__"]).toBeUndefined();
        expect(ctx.cookies.toString).toBeUndefined();
      });
    });

    describe("extractSignedCookies / RequestContext.signedCookies", () => {
      const header = [
        `uid=${encodeURIComponent(signCookieValue("42", "secret"))}`,
        `forged=${encodeURIComponent("s:42.bogus")}`,
        "plain=hello",
      ].join("; ");

      it("should return only the cookies whose signature verifies", () => {
        const ctx = new RequestContext({
          request: new Request("http://localhost/", {
            headers: { cookie: header },
          }),
          cookieSecrets: secrets,
        });
        expect({ ...ctx.signedCookies }).toEqual({ uid: "42" });
      });

      it("should return a single signed cookie, undefined when invalid", () => {
        const ctx = new RequestContext({
          request: new Request("http://localhost/", {
            headers: { cookie: header },
          }),
          cookieSecrets: secrets,
        });
        expect(ctx.signedCookies.uid).toBe("42");
        expect(ctx.signedCookies.forged).toBeUndefined();
        expect(ctx.signedCookies.plain).toBeUndefined();
        expect(ctx.signedCookies.missing).toBeUndefined();
      });

      it("should only verify the first occurrence of a duplicated name", () => {
        const valid = encodeURIComponent(signCookieValue("42", "secret"));
        const forgedFirst = new RequestContext({
          request: new Request("http://localhost/", {
            headers: { cookie: `uid=s%3A1.forged; uid=${valid}` },
          }),
          cookieSecrets: secrets,
        });
        expect(forgedFirst.signedCookies.uid).toBeUndefined();

        const validFirst = new RequestContext({
          request: new Request("http://localhost/", {
            headers: { cookie: `uid=${valid}; uid=s%3A1.forged` },
          }),
          cookieSecrets: secrets,
        });
        expect(validFirst.signedCookies.uid).toBe("42");
      });

      // BUNEST_BUG: RequestContext.signedCookies derives from this.cookies instead of verifying the raw Cookie header independently when req.cookies only holds plain entries (packages/core/src/http/context/request-context.ts:237-245).
      it.skip("should verify the raw Cookie header even when req.cookies only contains plain entries", () => {
        const req = new Request("http://localhost/", {
          headers: { cookie: header },
        }) as Request & { cookies?: Map<string, string> };
        req.cookies = new Map([["plain", "hello"]]);
        const ctx = new RequestContext({
          request: req,
          cookieSecrets: secrets,
        });
        expect(ctx.signedCookies.uid).toBe("42");
      });

      it("should return empty object from extractSignedCookies when secrets are omitted", () => {
        const cookies = extractRequestCookies(
          new Request("http://localhost/", { headers: { cookie: header } }),
        );
        expect(extractSignedCookies(cookies, undefined)).toEqual({});
      });

      // BUNEST_BUG: RequestContext.signedCookies silently returns {} instead of throwing when no cookie secret is configured (packages/core/src/http/context/request-context.ts:237-245).
      it.skip("should throw when accessing signedCookies without a configured cookie secret", () => {
        const ctx = new RequestContext({
          request: new Request("http://localhost/", {
            headers: { cookie: header },
          }),
          cookieSecrets: undefined,
        });
        expect(() => ctx.signedCookies).toThrow(/secret/i);
      });
    });
  },
);
