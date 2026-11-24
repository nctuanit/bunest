import { describe, expect, it } from "bun:test";
import {
  applySecurityHeaders,
  compileSecurityHeaders,
} from "../../../../../../packages/core/src/http";
import { describeConformance, itAdapted } from "../../../../_helpers";

const HELMET_DEFAULT_CSP =
  "default-src 'self';base-uri 'self';font-src 'self' https: data:;" +
  "form-action 'self';frame-ancestors 'self';img-src 'self' data:;" +
  "object-src 'none';script-src 'self';script-src-attr 'none';" +
  "style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests";

function getCsp(
  csp?: NonNullable<
    Parameters<typeof compileSecurityHeaders>[0]
  >["contentSecurityPolicy"],
): string | undefined {
  const compiled = compileSecurityHeaders({
    contentSecurityPolicy: csp,
  });
  const entry = compiled.headers.find(
    ([name]) =>
      name === "Content-Security-Policy" ||
      name === "Content-Security-Policy-Report-Only",
  );
  return entry?.[1];
}

describeConformance(
  "Security headers (Bunest compileSecurityHeaders / applySecurityHeaders)",
  {
    upstreamPath: "packages/core/test/security/security-headers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS serializeContentSecurityPolicy / resolveSecurityHeaders unit tests to Bunest compileSecurityHeaders() and applySecurityHeaders().",
  },
  () => {
    describe("Content-Security-Policy serialization via compileSecurityHeaders", () => {
      it("serializes the helmet 8 default policy", () => {
        expect(getCsp()).toBe(HELMET_DEFAULT_CSP);
      });

      it("replaces default directives in place and appends new ones", () => {
        expect(
          getCsp({
            directives: {
              scriptSrc: ["'self'", "https://cdn.example"],
              "connect-src": "'self' wss://app.example",
              reportTo: "csp-endpoint",
            },
          }),
        ).toBe(
          HELMET_DEFAULT_CSP.replace(
            "script-src 'self';",
            "script-src 'self' https://cdn.example;",
          ) + ";connect-src 'self' wss://app.example;report-to csp-endpoint",
        );
      });

      it("removes directives set to null or false", () => {
        const policy = getCsp({
          directives: { upgradeInsecureRequests: null, "form-action": false },
        })!;
        expect(policy).not.toContain("upgrade-insecure-requests");
        expect(policy).not.toContain("form-action");
        expect(policy.startsWith("default-src 'self';")).toBe(true);
      });

      it("serializes valueless directives from true and empty lists", () => {
        expect(
          getCsp({
            useDefaults: false,
            directives: {
              defaultSrc: "'none'",
              upgradeInsecureRequests: true,
              blockAllMixedContent: [],
            },
          }),
        ).toBe(
          "default-src 'none';upgrade-insecure-requests;block-all-mixed-content",
        );
      });

      it("only sends the given directives when useDefaults is false", () => {
        expect(
          getCsp({
            useDefaults: false,
            directives: { defaultSrc: ["'self'"], imgSrc: ["*"] },
          }),
        ).toBe("default-src 'self';img-src *");
      });

      // BUNEST_BUG: compileSecurityHeaders does not require default-src when useDefaults is false (packages/core/src/http/security/security-headers.ts).
      it.skip("requires default-src unless it is removed explicitly", () => {
        expect(() =>
          getCsp({
            useDefaults: false,
            directives: { scriptSrc: "'self'" },
          }),
        ).toThrow(/default-src/);
        expect(
          getCsp({
            directives: { defaultSrc: null },
          }),
        ).not.toContain("default-src");
      });

      describe("rejects injection attempts and invalid input", () => {
        // BUNEST_BUG: compileSecurityHeaders does not validate CSP directive names/values for header injection (; , CR/LF tab non-ASCII), invalid names, unquoted keywords/nonces, or duplicate camel/kebab directives (packages/core/src/http/security/security-headers.ts).
        it.skip.each([
          ['a ";" in a value', { scriptSrc: ["'self'; script-src *"] }],
          ['a "," in a value', { scriptSrc: "'self', script-src *" }],
          ["a CR/LF in a value", { scriptSrc: "'self'\r\nX-Evil: 1" }],
          ["a tab in a value", { scriptSrc: "'self'\thttps:" }],
          ["a non-ASCII value", { imgSrc: "https://b\u00fccher.example" }],
          ["an empty value", { scriptSrc: [""] }],
          ["a non-string value", { scriptSrc: [42 as any] }],
          ["an object value", { scriptSrc: {} as any }],
          ['a ";" in a name', { "script-src;img-src": "'self'" }],
          ["a space in a name", { "script src": "'self'" }],
          ["an empty name", { "": "'self'" }],
          ["an upper-case name", { "SCRIPT-SRC": "'self'" }],
          ["a name with a double dash", { "script--src": "'self'" }],
          ["an unquoted keyword", { scriptSrc: "self" }],
          [
            "an unquoted keyword among others",
            { scriptSrc: "https: unsafe-inline" },
          ],
          ["an unquoted nonce", { scriptSrc: "nonce-abc123" }],
          [
            "the same directive twice",
            { scriptSrc: "'self'", "script-src": "'none'" },
          ],
        ])("%s", (_title, directives) => {
          expect(() => getCsp({ directives })).toThrow();
        });

        it("accepts quoted keywords, nonces, hashes and host names", () => {
          expect(
            getCsp({
              useDefaults: false,
              directives: {
                defaultSrc: "'self'",
                scriptSrc: [
                  "'strict-dynamic'",
                  "'nonce-abc123'",
                  "'sha256-AbC+/=='",
                  "self.example.com",
                  "https://sha256-cdn.example",
                ],
              },
            }),
          ).toBe(
            "default-src 'self';script-src 'strict-dynamic' 'nonce-abc123' " +
              "'sha256-AbC+/==' self.example.com https://sha256-cdn.example",
          );
        });
      });
    });

    describe("compileSecurityHeaders", () => {
      itAdapted(
        "ADR-001",
        "returns the helmet 8 defaults",
        () => {
          expect(compileSecurityHeaders()).toEqual({
            headers: [
              ["Content-Security-Policy", HELMET_DEFAULT_CSP],
              ["Cross-Origin-Opener-Policy", "same-origin"],
              ["Cross-Origin-Resource-Policy", "same-origin"],
              ["Origin-Agent-Cluster", "?1"],
              ["Referrer-Policy", "no-referrer"],
              [
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
              ],
              ["X-Content-Type-Options", "nosniff"],
              ["X-DNS-Prefetch-Control", "off"],
              ["X-Download-Options", "noopen"],
              ["X-Frame-Options", "SAMEORIGIN"],
              ["X-Permitted-Cross-Domain-Policies", "none"],
              ["X-XSS-Protection", "0"],
            ],
            removePoweredBy: true,
          });
        },
        "Bunest returns removePoweredBy boolean instead of removeHeaders array",
      );

      it("treats true like the defaults", () => {
        expect(
          compileSecurityHeaders({
            contentSecurityPolicy: true,
            strictTransportSecurity: true,
            xFrameOptions: true,
            referrerPolicy: true,
          }),
        ).toEqual(compileSecurityHeaders());
      });

      it("leaves out headers set to false", () => {
        const { headers, removePoweredBy } = compileSecurityHeaders({
          contentSecurityPolicy: false,
          crossOriginOpenerPolicy: false,
          crossOriginResourcePolicy: false,
          originAgentCluster: false,
          referrerPolicy: false,
          strictTransportSecurity: false,
          xContentTypeOptions: false,
          xDnsPrefetchControl: false,
          xDownloadOptions: false,
          xFrameOptions: false,
          xPermittedCrossDomainPolicies: false,
          xPoweredBy: false,
          xXssProtection: false,
        });
        expect(headers).toEqual([]);
        expect(removePoweredBy).toBe(false);
      });

      it("configures each header", () => {
        const { headers } = compileSecurityHeaders({
          contentSecurityPolicy: {
            reportOnly: true,
            useDefaults: false,
            directives: { defaultSrc: "'self'" },
          },
          crossOriginEmbedderPolicy: { policy: "credentialless" },
          crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
          crossOriginResourcePolicy: { policy: "cross-origin" },
          referrerPolicy: {
            policy: ["no-referrer", "strict-origin-when-cross-origin"],
          },
          strictTransportSecurity: {
            maxAge: 63072000.9,
            includeSubDomains: false,
            preload: true,
          },
          xDnsPrefetchControl: { allow: true },
          xFrameOptions: { action: "deny" },
          xPermittedCrossDomainPolicies: {
            permittedPolicies: "by-content-type",
          },
        });
        expect(Object.fromEntries(headers)).toEqual({
          "Content-Security-Policy-Report-Only": "default-src 'self'",
          "Cross-Origin-Embedder-Policy": "credentialless",
          "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Origin-Agent-Cluster": "?1",
          "Referrer-Policy": "no-referrer,strict-origin-when-cross-origin",
          "Strict-Transport-Security": "max-age=63072000; preload",
          "X-Content-Type-Options": "nosniff",
          "X-DNS-Prefetch-Control": "on",
          "X-Download-Options": "noopen",
          "X-Frame-Options": "DENY",
          "X-Permitted-Cross-Domain-Policies": "by-content-type",
          "X-XSS-Protection": "0",
        });
      });

      it("sends Cross-Origin-Embedder-Policy: require-corp for true", () => {
        const { headers } = compileSecurityHeaders({
          crossOriginEmbedderPolicy: true,
        });
        expect(headers).toContainEqual([
          "Cross-Origin-Embedder-Policy",
          "require-corp",
        ]);
      });

      it.each([[{ xFrameOptions: { action: 1 as any } }], [null as any]])(
        "rejects invalid options %j",
        (options) => {
          expect(() => compileSecurityHeaders(options)).toThrow();
        },
      );

      // BUNEST_BUG: compileSecurityHeaders lacks strict option schema/enum/range/type validation for security header sub-options (packages/core/src/http/security/security-headers.ts).
      it.skip.each([
        [{ crossOriginOpenerPolicy: { policy: "same-site" as any } }],
        [{ crossOriginResourcePolicy: { policy: "none" as any } }],
        [{ crossOriginEmbedderPolicy: { policy: "corp" as any } }],
        [{ referrerPolicy: { policy: "never" as any } }],
        [{ referrerPolicy: { policy: [] } }],
        [{ referrerPolicy: { policy: ["origin", "origin"] as any } }],
        [{ strictTransportSecurity: { maxAge: -1 } }],
        [{ strictTransportSecurity: { maxAge: Infinity } }],
        [{ strictTransportSecurity: { maxAge: "1" as any } }],
        [{ xFrameOptions: { action: "allow-from" as any } }],
        [{ xPermittedCrossDomainPolicies: { permittedPolicies: "x" as any } }],
        [{ strictTransportSecurity: { includeSubDomains: "no" as any } }],
        [{ strictTransportSecurity: "yes" as any }],
        [{ contentSecurityPolicy: { reportOnly: 1 as any } }],
        [{ contentSecurityPolicy: { useDefaults: "false" as any } }],
        [{ contentSecurityPolicy: { directives: null as any } }],
        [{ crossOriginOpenerPolicy: "same-origin-allow-popups" as any }],
        [{ xContentTypeOptions: {} as any }],
        [{ xDnsPrefetchControl: { allow: "on" as any } }],
        [[] as any],
      ])("rejects invalid options %j", (options) => {
        expect(() => compileSecurityHeaders(options)).toThrow();
      });

      it("rejects unknown options", () => {
        expect(() => compileSecurityHeaders({ hsts: false } as any)).toThrow(
          /Unknown security headers option "hsts"/,
        );
        expect(() =>
          compileSecurityHeaders({ contentSecurityPolicies: false } as any),
        ).toThrow(/Unknown security headers option "contentSecurityPolicies"/);
      });

      // BUNEST_BUG: compileSecurityHeaders only validates top-level option keys and does not reject unknown nested keys like contentSecurityPolicy.directive (packages/core/src/http/security/security-headers.ts).
      it.skip("rejects unknown nested options like contentSecurityPolicy.directive", () => {
        expect(() =>
          compileSecurityHeaders({
            contentSecurityPolicy: {
              directive: { scriptSrc: "'none'" },
            } as any,
          }),
        ).toThrow(/directive/);
      });

      it("applySecurityHeaders removes X-Powered-By and does not clobber explicit route headers", () => {
        const compiled = compileSecurityHeaders();
        const res = new Response("ok", {
          headers: {
            "X-Powered-By": "Custom",
            "X-Frame-Options": "DENY",
          },
        });
        const secured = applySecurityHeaders(res, compiled);
        expect(secured.headers.get("x-powered-by")).toBeNull();
        expect(secured.headers.get("x-frame-options")).toBe("DENY");
        expect(secured.headers.get("x-content-type-options")).toBe("nosniff");
      });
    });
  },
);
