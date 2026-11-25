import { describe, expect, it } from "bun:test";
import {
  ForbiddenException,
  RequestMethod,
} from "../../../../../../packages/core/src/common";
import {
  compileCsrfProtection,
  type CompiledCsrfProtection,
} from "../../../../../../packages/core/src/http";
import {
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../../_helpers";

function makeReq(
  method: string,
  url: string,
  headers: Record<string, string | undefined> = {},
): { req: Request; pathname: string } {
  const cleanHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      cleanHeaders[k] = v;
    }
  }
  // Construct a synthetic Request even for non-canonical paths by preserving raw pathname
  const fullUrl =
    url.startsWith("http://") || url.startsWith("https://")
      ? url
      : `http://app.example${url.startsWith("/") ? url : `/${url}`}`;
  const req = new Request(fullUrl, { method, headers: cleanHeaders });
  const qIdx = url.indexOf("?");
  const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
  return { req, pathname };
}

function checkAllowed(
  protection: CompiledCsrfProtection,
  method: string,
  url: string,
  headers: Record<string, string | undefined> = {},
): boolean {
  const { req, pathname } = makeReq(method, url, headers);
  try {
    protection.evaluate(req, pathname);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenException) {
      return false;
    }
    throw err;
  }
}

describeConformance(
  "CrossOriginProtection (Bunest compileCsrfProtection)",
  {
    upstreamPath: "packages/core/test/security/cross-origin-protection.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS CrossOriginProtection / evaluateCrossOriginRequest / normalizeTrustedOrigin unit tests to Bunest compileCsrfProtection(options, globalPrefix).",
  },
  () => {
    describe("evaluateCrossOriginRequest behavior via compileCsrfProtection", () => {
      const protection = compileCsrfProtection({
        trustedOrigins: ["https://trusted.example"],
      });

      type Row = [
        title: string,
        method: string,
        headers: Record<string, string | undefined>,
        expectedAllowed: boolean,
      ];

      const rows: Row[] = [
        ...(["GET", "HEAD", "OPTIONS"] as const).map((method): Row => [
          `${method} cross-site`,
          method,
          {
            "sec-fetch-site": "cross-site",
            origin: "https://evil.example",
            host: "app.example",
          },
          true,
        ]),
        [
          "POST same-origin",
          "POST",
          { "sec-fetch-site": "same-origin", host: "app.example" },
          true,
        ],
        [
          "POST none (user-initiated)",
          "POST",
          { "sec-fetch-site": "none", host: "app.example" },
          true,
        ],
        [
          "POST same-origin ignores a mismatching Origin",
          "POST",
          {
            "sec-fetch-site": "same-origin",
            origin: "https://evil.example",
            host: "app.example",
          },
          true,
        ],
        [
          "POST cross-site",
          "POST",
          {
            "sec-fetch-site": "cross-site",
            origin: "https://evil.example",
            host: "app.example",
          },
          false,
        ],
        [
          "PUT same-site (sibling subdomain) is cross-origin",
          "PUT",
          {
            "sec-fetch-site": "same-site",
            origin: "https://sub.app.example",
            host: "app.example",
          },
          false,
        ],
        [
          "DELETE with an unknown Sec-Fetch-Site value",
          "DELETE",
          { "sec-fetch-site": "bogus", host: "app.example" },
          false,
        ],
        [
          "POST with duplicated Sec-Fetch-Site values",
          "POST",
          { "sec-fetch-site": "same-origin, cross-site", host: "app.example" },
          false,
        ],
        [
          "Sec-Fetch-Site cross-site with Origin matching Host is still rejected",
          "POST",
          {
            "sec-fetch-site": "cross-site",
            origin: "https://app.example",
            host: "app.example",
          },
          false,
        ],
        [
          "cross-site from a trusted origin",
          "POST",
          {
            "sec-fetch-site": "cross-site",
            origin: "https://trusted.example",
            host: "app.example",
          },
          true,
        ],
        [
          "cross-site: trusted origins match exactly (scheme)",
          "POST",
          {
            "sec-fetch-site": "cross-site",
            origin: "http://trusted.example",
            host: "app.example",
          },
          false,
        ],
        [
          "POST without Sec-Fetch-Site and without Origin (non-browser)",
          "POST",
          { host: "app.example" },
          true,
        ],
        [
          "empty headers count as absent",
          "POST",
          { "sec-fetch-site": "", origin: "", host: "app.example" },
          true,
        ],
        [
          "Origin host matches Host",
          "POST",
          { origin: "https://app.example", host: "app.example" },
          true,
        ],
        [
          "Origin host matches Host including the port",
          "PATCH",
          { origin: "http://localhost:3000", host: "localhost:3000" },
          true,
        ],
        [
          "Origin host matches Host case-insensitively",
          "POST",
          { origin: "https://app.example", host: "APP.example" },
          true,
        ],
        [
          "Origin host does not match Host with the default port of another scheme",
          "POST",
          { origin: "http://app.example", host: "app.example:443" },
          false,
        ],
        [
          "Origin with an explicit port does not match Host without it",
          "POST",
          { origin: "https://app.example:8443", host: "app.example" },
          false,
        ],
        [
          "IPv6 Origin host matches Host",
          "POST",
          { origin: "http://[::1]:3000", host: "[::1]:3000" },
          true,
        ],
        [
          "Origin on another port",
          "POST",
          { origin: "http://localhost:4000", host: "localhost:3000" },
          false,
        ],
        [
          "Origin on another host",
          "POST",
          { origin: "https://evil.example", host: "app.example" },
          false,
        ],
        [
          'opaque Origin "null"',
          "POST",
          { origin: "null", host: "app.example" },
          false,
        ],
        [
          "Origin without a Host header",
          "POST",
          { origin: "https://app.example" },
          false,
        ],
        [
          "Origin mismatch from a trusted origin",
          "POST",
          { origin: "https://trusted.example", host: "app.example" },
          true,
        ],
      ];

      it.each(rows)("%s", (_title, method, headers, expectedAllowed) => {
        expect(checkAllowed(protection, method, "/items", headers)).toBe(
          expectedAllowed,
        );
      });

      it("allows Origin host matching Host with default port of its scheme (443/80/IPv6)", () => {
        expect(
          checkAllowed(protection, "POST", "/items", {
            origin: "https://app.example",
            host: "app.example:443",
          }),
        ).toBe(true);
        expect(
          checkAllowed(protection, "POST", "/items", {
            origin: "http://app.example",
            host: "app.example:80",
          }),
        ).toBe(true);
        expect(
          checkAllowed(protection, "POST", "/items", {
            origin: "https://[::1]",
            host: "[::1]:443",
          }),
        ).toBe(true);
      });

      it("allows rejected requests that are excluded by predicate", () => {
        const isExcluded = createSpy(() => true);
        const p = compileCsrfProtection({ exclude: isExcluded });
        expect(
          checkAllowed(p, "POST", "/items", {
            "sec-fetch-site": "cross-site",
            host: "app.example",
          }),
        ).toBe(true);
        expect(isExcluded.calledOnce).toBe(true);
      });

      it("only evaluates exclusions for requests that would be rejected", () => {
        const isExcluded = createSpy(() => true);
        const p = compileCsrfProtection({ exclude: isExcluded });
        expect(
          checkAllowed(p, "POST", "/items", {
            "sec-fetch-site": "same-origin",
          }),
        ).toBe(true);
        expect(checkAllowed(p, "GET", "/items")).toBe(true);
        expect(isExcluded.callCount).toBe(0);
      });
    });

    describe("trustedOrigins normalization and validation", () => {
      it.each([
        ["https://example.com", "https://example.com"],
        ["https://Example.COM", "https://example.com"],
        ["https://example.com:443", "https://example.com"],
        ["http://localhost:4200", "http://localhost:4200"],
        ["http://[::1]:3000", "http://[::1]:3000"],
        ["https://b\u00fccher.example", "https://xn--bcher-kva.example"],
      ])("normalizes %s and matches %s", (configured, requestOrigin) => {
        const p = compileCsrfProtection({ trustedOrigins: [configured] });
        expect(
          checkAllowed(p, "POST", "/items", {
            "sec-fetch-site": "cross-site",
            origin: requestOrigin,
            host: "app.example",
          }),
        ).toBe(true);
      });

      it("supports non-http/https serialized origins like chrome-extension://", () => {
        const p = compileCsrfProtection({
          trustedOrigins: ["chrome-extension://abcdef"],
        });
        expect(
          checkAllowed(p, "POST", "/items", {
            "sec-fetch-site": "cross-site",
            origin: "chrome-extension://abcdef",
            host: "app.example",
          }),
        ).toBe(true);
      });

      it.each([
        "",
        "*",
        "example.com",
        "https://",
        "https://example.com/",
        "https://example.com/path",
        "https://example.com?x=1",
        "https://example.com#frag",
        "https://*.example.com",
        "null",
      ])("rejects invalid trusted origin %j", (input) => {
        expect(() =>
          compileCsrfProtection({ trustedOrigins: [input] }),
        ).toThrow(/Invalid trusted origin/);
      });

      it.each([
        "https://user:pass@example.com",
        "https://example.com/.",
        "https://example.com/%2e%2e",
        "https:\\\\example.com",
      ])("rejects invalid trusted origin %j", (input) => {
        expect(() =>
          compileCsrfProtection({ trustedOrigins: [input] }),
        ).toThrow(/Invalid trusted origin/);
      });
    });

    describe("CrossOriginProtection checks", () => {
      const crossSiteHeaders = {
        host: "app.example",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      };

      it("throws a ForbiddenException (403) for cross-origin requests", () => {
        const p = compileCsrfProtection();
        const { req, pathname } = makeReq("POST", "/items", crossSiteHeaders);
        let caught: unknown;
        try {
          p.evaluate(req, pathname);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ForbiddenException);
        expect((caught as ForbiddenException).getStatus()).toBe(403);
      });

      it("allows same-origin requests", () => {
        const p = compileCsrfProtection();
        expect(
          checkAllowed(p, "POST", "/items", {
            host: "app.example",
            "sec-fetch-site": "same-origin",
          }),
        ).toBe(true);
      });

      it("honors trusted origins case-insensitively", () => {
        const p = compileCsrfProtection({
          trustedOrigins: ["https://EVIL.example"],
        });
        expect(checkAllowed(p, "POST", "/items", crossSiteHeaders)).toBe(true);
      });

      describe("exclude", () => {
        const isExcluded = (
          p: CompiledCsrfProtection,
          url: string,
          method = "POST",
        ) => checkAllowed(p, method, url, crossSiteHeaders);

        it("matches exact RouteInfo entries and ignores the query string", () => {
          const p = compileCsrfProtection({
            exclude: [{ path: "payments/callback", method: RequestMethod.PUT }],
          });
          expect(isExcluded(p, "/payments/callback", "PUT")).toBe(true);
          expect(isExcluded(p, "/payments/callback?x=1", "PUT")).toBe(true);
          expect(isExcluded(p, "/payments/callback", "POST")).toBe(false);
          expect(isExcluded(p, "/items")).toBe(false);
        });

        it("matches wildcard path exclusions like webhooks/*path", () => {
          const p = compileCsrfProtection({
            exclude: ["webhooks/*path"],
          });
          expect(isExcluded(p, "/webhooks/stripe?x=1")).toBe(true);
          expect(isExcluded(p, "/items")).toBe(false);
        });

        it("adds the global prefix and only matches the prefixed path", () => {
          const p = compileCsrfProtection({ exclude: ["webhooks"] }, "/api/");
          expect(isExcluded(p, "/api/webhooks")).toBe(true);
          expect(isExcluded(p, "/webhooks")).toBe(false);
          expect(isExcluded(p, "/api/api/webhooks")).toBe(false);
          expect(isExcluded(p, "/apiwebhooks")).toBe(false);
          expect(isExcluded(p, "/api/items")).toBe(false);
        });

        it("matches case-sensitively and without a trailing slash", () => {
          const p = compileCsrfProtection({ exclude: ["webhooks"] });
          expect(isExcluded(p, "/webhooks")).toBe(true);
          expect(isExcluded(p, "/WEBHOOKS")).toBe(false);
          expect(isExcluded(p, "/Webhooks")).toBe(false);
          expect(isExcluded(p, "/webhooks/")).toBe(false);
          expect(isExcluded(p, "/webhooks/x")).toBe(false);
        });

        it.each([
          "/web%68ooks",
          "//webhooks",
          "/webhooks;x",
          "/webhooks#x",
          "/hooks/a/../../items",
          "/hooks/./a",
          "/hooks/a/..",
          "/hooks/%2e%2e/items",
          "/hooks/.%2E/items",
          "/hooks/a%2F..%2F..%2Fitems",
          "/hooks/a%5c..%5citems",
          "/hooks/a\\..\\items",
          "/hooks//a",
          "/hooks/a%0A",
          "/hooks/a%0d.pdf",
          "/hooks/a\n",
          "/hooks/a%E2%80%A8",
          "/hooks/a%e2%80%a9",
          "http://app.example/webhooks",
          "",
        ])("never excludes the non-canonical path %j", (url) => {
          const p = compileCsrfProtection({
            exclude: ["webhooks", "hooks/*path"],
          });
          expect(isExcluded(p, url)).toBe(false);
        });

        it("accepts a predicate", () => {
          const p = compileCsrfProtection({
            exclude: (request) =>
              new URL(request.url).pathname.startsWith("/public/"),
          });
          expect(isExcluded(p, "/public/form")).toBe(true);
          expect(isExcluded(p, "/private")).toBe(false);
        });

        itAdapted(
          "ADR-001",
          "treats non-boolean predicate return values as not excluded (strict === true)",
          () => {
            const pPromise = compileCsrfProtection({
              exclude: (() => Promise.resolve(true)) as any,
            });
            const pTruthy = compileCsrfProtection({
              exclude: (() => ["/public/form"]) as any,
            });
            const pUndefined = compileCsrfProtection({
              exclude: (() => undefined) as any,
            });
            expect(isExcluded(pPromise, "/public/form")).toBe(false);
            expect(isExcluded(pTruthy, "/public/form")).toBe(false);
            expect(isExcluded(pUndefined, "/public/form")).toBe(false);
          },
          "Bunest checks excludePredicate(req) === true",
        );
      });
    });
  },
);
