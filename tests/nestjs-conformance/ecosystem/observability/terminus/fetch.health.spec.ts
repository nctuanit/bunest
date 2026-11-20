import "reflect-metadata";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { HttpService } from "../../../../../packages/axios/src";
import {
  HttpClient,
  type HttpResponse,
} from "../../../../../packages/http-client/src";
import {
  FetchHealthIndicator,
  HealthIndicatorService,
  type FetchLike,
} from "../../../../../packages/observability/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type IsAny<T> = 0 extends 1 & T ? true : false;

async function waitFor(
  assertion: () => void,
  timeoutMs = 1500,
  intervalMs = 15,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await Bun.sleep(intervalMs);
    }
  }
  assertion();
  if (lastError) {
    throw lastError;
  }
}

describeConformance(
  "FetchHealthIndicator",
  {
    upstreamPath: "terminus/lib/health-indicator/http/fetch.health.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream @nestjs/terminus FetchHealthIndicator tests to Bunest native fetch, @bunest/http-client, and Promise-based @bunest/axios (ADR-001/ADR-008: zero RxJS).",
  },
  () => {
    let server: Server;
    let base: string;
    let closed: string;
    let aborted = 0;
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

    beforeAll(async () => {
      server = createServer((req, res) => {
        let slowTimer: ReturnType<typeof setTimeout> | undefined;
        req.on("close", () => {
          if (slowTimer !== undefined) {
            clearTimeout(slowTimer);
            pendingTimers.delete(slowTimer);
          }
          if (!res.writableEnded) {
            aborted++;
          }
        });
        if (req.url === "/slow") {
          slowTimer = setTimeout(() => {
            if (slowTimer !== undefined) {
              pendingTimers.delete(slowTimer);
            }
            if (!res.writableEnded) {
              res.end();
            }
          }, 2000);
          pendingTimers.add(slowTimer);
          return;
        }
        if (req.url === "/down") {
          res.writeHead(503).end("nope");
          return;
        }
        res.writeHead(req.url === "/empty" ? 204 : 200).end("woof");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const probe = createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, "127.0.0.1", resolve),
      );
      closed = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    });

    afterAll(async () => {
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const indicator = new FetchHealthIndicator(new HealthIndicatorService());

    const httpClient = new HttpClient({ retry: false });
    const axios = new HttpService();
    const clients: Record<string, FetchLike | undefined> = {
      "native fetch": undefined,
      "@bunest/http-client": httpClient.request as unknown as FetchLike,
      "@bunest/axios": (url, init) => axios.request({ url, ...init }),
    };

    describe.each(Object.entries(clients))(
      "FetchHealthIndicator with %s",
      (clientName, fetch) => {
        it("is up on 2xx", async () => {
          const result = await indicator.pingCheck("dep", `${base}/ok`, {
            fetch,
          });
          expect(result.dep).toMatchObject({ status: "up" });
          expect(result.dep).toHaveProperty("responseTime");
        });

        it("is down on 5xx and keeps statusCode/statusText", async () => {
          const result = await indicator.pingCheck("dep", `${base}/down`, {
            fetch,
          });
          expect(result.dep).toEqual({
            status: "down",
            message: "Request failed with status code 503",
            statusCode: 503,
            statusText: "Service Unavailable",
            responseTime: expect.any(Number),
          });
        });

        it("is down when the host is unreachable", async () => {
          const result = await indicator.pingCheck("dep", closed, { fetch });
          expect(result.dep).toMatchObject({
            status: "down",
            message: expect.stringContaining("ECONNREFUSED"),
          });
        });

        it("times out after 1000 ms by default", async () => {
          const result = await indicator.pingCheck("dep", `${base}/slow`, {
            fetch,
          });
          expect(result.dep).toMatchObject({
            status: "down",
            message: "timeout of 1000ms exceeded",
          });
        });

        itAdapted(
          ["ADR-001", "ADR-008"],
          `aborts the request on withTimeout() (${clientName})`,
          async () => {
            const before = aborted;
            const result = await indicator
              .pingCheck("dep", `${base}/slow`, { fetch })
              .withTimeout(50);
            expect(result.dep).toMatchObject({
              status: "down",
              message: "timeout of 50ms exceeded",
            });
            await waitFor(() => expect(aborted).toBeGreaterThanOrEqual(before + 1));
          },
          "Uses local waitFor helper and Promise-based clients without RxJS",
        );
      },
    );

    describe("FetchHealthIndicator#pingCheck with verify", () => {
      it("is up when verify returns true", async () => {
        const result = await indicator.pingCheck("dep", `${base}/ok`, {
          verify: async (res) => (await res.text()) === "woof",
        });
        expect(result.dep).toMatchObject({ status: "up" });
      });

      it("is down with the status when verify returns false", async () => {
        const result = await indicator.pingCheck("dep", `${base}/ok`, {
          verify: (res) => res.status === 204,
        });
        expect(result.dep).toEqual({
          status: "down",
          message: "Response did not pass the check",
          statusCode: 200,
          statusText: "OK",
          responseTime: expect.any(Number),
        });
      });

      it("is down with the error message and status when verify throws", async () => {
        const result = await indicator.pingCheck("dep", `${base}/ok`, {
          verify: () => {
            throw new Error("version too old");
          },
        });
        expect(result.dep).toEqual({
          status: "down",
          message: "version too old",
          statusCode: 200,
          statusText: "OK",
          responseTime: expect.any(Number),
        });
      });

      it("replaces the 2xx rule", async () => {
        const result = await indicator.pingCheck("dep", `${base}/down`, {
          verify: (res) => res.status === 503,
        });
        expect(result.dep).toMatchObject({ status: "up" });
      });

      it("types the response from the fetch function", () => {
        // Only the types are checked: the attempts are never awaited.
        indicator.pingCheck("dep", base, {
          verify: (res) => {
            const _isResponse: AssertEqual<typeof res, Response> = true;
            return _isResponse;
          },
        });
        indicator.pingCheck("dep", base, {
          fetch: (url, init) => httpClient.request(url, init),
          verify: (res) => {
            const _isHttpRes: AssertEqual<typeof res, HttpResponse<unknown>> =
              true;
            return _isHttpRes;
          },
        });
        indicator.pingCheck("dep", base, {
          fetch: async () => ({ status: 200, version: "1.2.3" }),
          verify: (res) => {
            const _isCustom: AssertEqual<
              typeof res,
              { status: number; version: string }
            > = true;
            return _isCustom;
          },
        });
        expect(true).toBe(true);
      });

      it("types statusCode and statusText on a failed result", async () => {
        const result = await indicator.pingCheck("dep", `${base}/down`);
        if (result.dep.status === "down") {
          const _codeCheck: AssertEqual<
            typeof result.dep.statusCode,
            number | undefined
          > = true;
          const _textCheck: AssertEqual<
            typeof result.dep.statusText,
            string | undefined
          > = true;
          expect(_codeCheck && _textCheck).toBe(true);
        }
        if (result.dep.status === "up") {
          const _upCodeIsAny: IsAny<typeof result.dep.statusCode> = true;
          expect(_upCodeIsAny).toBe(true);
        }
      });

      itAdapted(
        ["ADR-008"],
        "sees the response a client throws on 4xx/5xx (@bunest/axios)",
        async () => {
          const result = await indicator.pingCheck("dep", `${base}/down`, {
            fetch: clients["@bunest/axios"],
            verify: (res) => res.status === 503,
          });
          expect(result.dep).toMatchObject({ status: "up" });
        },
        "@bunest/axios returns Promises directly without RxJS",
      );

      it("does not see an error thrown without the response", async () => {
        const verify = mock(() => true);
        const result = await indicator.pingCheck("dep", `${base}/down`, {
          fetch: httpClient.request as unknown as FetchLike,
          verify,
        });
        expect(verify).not.toHaveBeenCalled();
        expect(result.dep).toMatchObject({ status: "down", statusCode: 503 });
      });

      it("sees the response of a client set not to throw on 4xx/5xx", async () => {
        const result = await indicator.pingCheck("dep", `${base}/down`, {
          fetch: (url, init) =>
            httpClient.request(url, { ...init, throwOnHttpError: false }),
          verify: (res) => res.status === 503,
        });
        expect(result.dep).toMatchObject({ status: "up" });
      });
    });

    describe("FetchHealthIndicator#pingCheck", () => {
      it("calls a custom fetch function with method, headers and signal", async () => {
        const fetch = mock(async () => ({ status: 200 }));
        const result = await indicator.pingCheck("dep", new URL(`${base}/ok`), {
          fetch,
          method: "HEAD",
          headers: { authorization: "Bearer token" },
        });
        expect(result.dep).toMatchObject({ status: "up" });
        expect(fetch).toHaveBeenCalledWith(`${base}/ok`, {
          method: "HEAD",
          headers: { authorization: "Bearer token" },
          signal: expect.any(AbortSignal),
        });
      });

      it("reports the status of a client that throws on non-2xx", async () => {
        const result = await indicator.pingCheck("dep", base, {
          fetch: () =>
            Promise.reject(
              Object.assign(new Error("Bad Gateway"), {
                response: { status: 502, statusText: "Bad Gateway" },
              }),
            ),
        });
        expect(result.dep).toMatchObject({
          status: "down",
          message: "Request failed with status code 502",
          statusCode: 502,
          statusText: "Bad Gateway",
        });
      });

      it("reuses an app's configured client (baseUrl, no retries for the probe)", async () => {
        const billing = new HttpClient({ baseUrl: base });
        const result = await indicator.pingCheck("billing", "/down", {
          fetch: (url, init) => billing.request(url, { ...init, retry: false }),
        });
        expect(result.billing).toMatchObject({
          status: "down",
          statusCode: 503,
        });
      });

      it("keeps the message and status with degradedOnFailure()", async () => {
        const result = await indicator
          .pingCheck("dep", `${base}/down`)
          .degradedOnFailure();
        expect(result.dep).toEqual({
          status: "degraded",
          message: "Request failed with status code 503",
          statusCode: 503,
          statusText: "Service Unavailable",
          responseTime: expect.any(Number),
        });
      });
    });
  },
);
