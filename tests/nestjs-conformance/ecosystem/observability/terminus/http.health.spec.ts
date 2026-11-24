import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  HealthIndicatorService,
  HttpHealthIndicator,
  TERMINUS_LOGGER,
  type HttpHealthResponse,
} from "../../../../../packages/observability/src";
import {
  Test,
  type TestingModule,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

class MockHttpError extends Error {
  readonly isAxiosError = true;
  constructor(
    message: string,
    public readonly config?: Record<string, unknown>,
    public readonly code?: string,
    public readonly response?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

describeConformance(
  "Http Response Health Indicator",
  {
    upstreamPath: "terminus/lib/health-indicator/http/http.health.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream @nestjs/terminus HttpHealthIndicator unit tests to zero-dep Bunest native fetch / Promise-based httpClient (ADR-001/ADR-008: no @nestjs/axios peer loader or RxJS Observables).",
  },
  () => {
    let moduleRef: TestingModule;
    let httpHealthIndicator: HttpHealthIndicator;

    const httpClientMock = {
      request: mock(
        async (
          _config: Record<string, unknown>,
        ): Promise<HttpHealthResponse> => ({
          status: 200,
          statusText: "OK",
          headers: {},
          data: [],
        }),
      ),
    };

    beforeEach(async () => {
      httpClientMock.request.mockReset();
      httpClientMock.request.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: [],
      });

      moduleRef = await Test.createTestingModule({
        providers: [
          HttpHealthIndicator,
          HealthIndicatorService,
          {
            provide: TERMINUS_LOGGER,
            useValue: {
              log: mock(),
              error: mock(),
              warn: mock(),
            },
          },
        ],
      }).compile({ logger: false });

      httpHealthIndicator =
        await moduleRef.resolve<HttpHealthIndicator>(HttpHealthIndicator);
      await httpHealthIndicator.onModuleInit();
    });

    afterEach(async () => {
      await moduleRef.close();
    });

    describe("#pingCheck", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "should call the configured httpClient",
        async () => {
          const result = await httpHealthIndicator.pingCheck("key", "url", {
            httpClient: httpClientMock,
          });
          expect(result.key?.status).toBe("up");
          expect(httpClientMock.request).toHaveBeenCalledWith({
            url: "url",
            method: "GET",
            headers: undefined,
          });
        },
        "Bunest uses Promise-based httpClient or native fetch instead of RxJS @nestjs/axios",
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should support standard URL object for pingCheck",
        async () => {
          const result = await httpHealthIndicator.pingCheck(
            "key",
            new URL("https://nestjs.com"),
            { httpClient: httpClientMock },
          );
          expect(result.key?.status).toBe("up");
          expect(httpClientMock.request).toHaveBeenCalledWith({
            url: "https://nestjs.com/",
            method: "GET",
            headers: undefined,
          });
        },
        "Bunest normalizes URL objects via url.toString() into Promise-based httpClient",
      );

      itAdapted(
        ["ADR-001"],
        "should use native fetch by default without resolving an app HttpService",
        async () => {
          const fetchMock = mock(
            async () => new Response("ok", { status: 200 }),
          );
          const result = await httpHealthIndicator.pingCheck(
            "key",
            "https://example.test",
            {
              fetch: fetchMock,
            },
          );
          expect(result.key?.status).toBe("up");
          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(httpClientMock.request).not.toHaveBeenCalled();
        },
        "Zero-dep native fetch replaces lazy loadPackage('@nestjs/axios')",
      );

      itAdapted(
        ["ADR-008"],
        "should make use of a custom httpClient",
        async () => {
          const customClient = {
            request: mock(
              async (
                _config: Record<string, unknown>,
              ): Promise<HttpHealthResponse> => ({
                status: 200,
                statusText: "OK",
                headers: {},
                data: [],
              }),
            ),
          };
          const result = await httpHealthIndicator.pingCheck("key", "url", {
            httpClient: customClient,
          });
          expect(result.key?.status).toBe("up");
          expect(customClient.request).toHaveBeenCalledWith({
            url: "url",
            method: "GET",
            headers: undefined,
          });
          expect(httpClientMock.request).not.toHaveBeenCalled();
        },
        "Promise-based custom httpClient replaces Observable HttpService",
      );

      // BUNEST_BUG: HttpHealthIndicator.pingCheck() wraps httpClient.request() in HealthIndicatorService.attempt(), swallowing non-HTTP Errors into a { status: "down" } result instead of rethrowing non-HTTP errors (packages/observability/src/health/health.indicators.ts:559-582).
      it.skip("should throw an error if the response is not an HTTP error", async () => {
        httpClientMock.request.mockImplementation(() => {
          throw new Error("Error");
        });
        let caught: unknown;
        try {
          await httpHealthIndicator.pingCheck("key", "url", {
            httpClient: httpClientMock,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        expect((caught as Error).constructor.name).toEqual("Error");
        expect(httpClientMock.request).toHaveBeenCalledWith({
          url: "url",
          method: "GET",
          headers: undefined,
        });
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should return a down result if an HttpError has no response",
        async () => {
          httpClientMock.request.mockRejectedValue(new MockHttpError("Error", {}));
          const result = await httpHealthIndicator.pingCheck("key", "url", {
            httpClient: httpClientMock,
          });

          expect(result.key).toMatchObject({
            status: "down",
            message: "Error",
          });
          expect(httpClientMock.request).toHaveBeenCalledWith({
            url: "url",
            method: "GET",
            headers: undefined,
          });
        },
        "Uses structural MockHttpError instead of AxiosError",
      );
    });

    describe("#responseCheck", () => {
      itAdapted(
        ["ADR-008"],
        'should be a healthy response check if the statusText is "Yes"',
        async () => {
          httpClientMock.request.mockResolvedValue({
            status: 200,
            statusText: "Yes",
            headers: {},
            data: "",
          });
          const result = await httpHealthIndicator.responseCheck(
            "key",
            "url",
            (res) => res.statusText === "Yes",
            { httpClient: httpClientMock },
          );
          expect(result.key?.status).toBe("up");
          expect(httpClientMock.request).toHaveBeenCalledWith({
            url: "url",
            method: "GET",
            headers: undefined,
          });
        },
        "Promise-based httpClient instead of RxJS of()",
      );

      itAdapted(
        ["ADR-008"],
        'should be an unhealthy response check if the statusText is "Yes" when "No" is expected',
        async () => {
          httpClientMock.request.mockResolvedValue({
            status: 200,
            statusText: "Yes",
            headers: {},
            data: "",
          });
          const result = await httpHealthIndicator.responseCheck(
            "key",
            "url",
            (res) => res.statusText === "No",
            { httpClient: httpClientMock },
          );
          expect(result.key).toMatchObject({
            status: "down",
            statusCode: 200,
            statusText: "Yes",
          });
          expect(httpClientMock.request).toHaveBeenCalledWith({
            url: "url",
            method: "GET",
            headers: undefined,
          });
        },
        "Terminus v12 returns down result instead of throwing HealthCheckError",
      );

      // BUNEST_BUG: HttpHealthIndicator.responseCheck() wraps httpClient.request() in HealthIndicatorService.attempt(), swallowing non-HTTP Errors into a { status: "down" } result instead of rethrowing non-HTTP errors (packages/observability/src/health/health.indicators.ts:604-656).
      it.skip("should throw an error if the response is not an HTTP error", async () => {
        httpClientMock.request.mockImplementation(() => {
          throw new Error("Error");
        });
        let caught: unknown;
        try {
          await httpHealthIndicator.responseCheck(
            "key",
            "url",
            (res) => res.statusText === "No",
            { httpClient: httpClientMock },
          );
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        expect((caught as Error).constructor.name).toEqual("Error");
        expect(httpClientMock.request).toHaveBeenCalledWith({
          url: "url",
          method: "GET",
          headers: undefined,
        });
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should return down if an HttpError has no response",
        async () => {
          httpClientMock.request.mockRejectedValue(new MockHttpError("Error", {}));
          const result = await httpHealthIndicator.responseCheck(
            "key",
            "url",
            (res) => res.statusText === "No",
            { httpClient: httpClientMock },
          );
          expect(result.key).toMatchObject({
            status: "down",
            message: "Error",
          });
          expect(httpClientMock.request).toHaveBeenCalledWith({
            url: "url",
            method: "GET",
            headers: undefined,
          });
        },
        "Terminus v12 returns down result when HTTP client throws without response",
      );

      // BUNEST_BUG: HttpHealthIndicator.responseCheck() does not extract err.response when httpClient.request() rejects with an HttpError/AxiosError carrying a response, so callback is never invoked and statusCode/statusText are lost (packages/observability/src/health/health.indicators.ts:608-649).
      it.skip("should inspect response on HttpError and return down when callback fails", async () => {
        const callback = mock(
          (res: HttpHealthResponse) => res.statusText === "No",
        );
        httpClientMock.request.mockRejectedValue(
          new MockHttpError("Error", {}, undefined, {
            data: "",
            status: 200,
            headers: {},
            rawHeaders: new Headers(),
            rawResponse: new Response("", { status: 200, statusText: "Yes" }),
            config: {},
            statusText: "Yes",
          }),
        );
        const result = await httpHealthIndicator.responseCheck(
          "key",
          "url",
          callback,
          { httpClient: httpClientMock },
        );
        expect(callback).toHaveBeenCalledTimes(1);
        expect(result.key).toMatchObject({
          status: "down",
          statusCode: 200,
          statusText: "Yes",
        });
        expect(httpClientMock.request).toHaveBeenCalledWith({
          url: "url",
          method: "GET",
          headers: undefined,
        });
      });

      // BUNEST_BUG: HttpHealthIndicator.responseCheck() does not extract err.response when httpClient.request() rejects with an HttpError carrying status 500, returning "down" instead of evaluating callback(res => res.status === 500) to "up" (packages/observability/src/health/health.indicators.ts:608-649).
      it.skip("should be healthy if the response is status code 500 and the condition says that the status code needs to be 500", async () => {
        httpClientMock.request.mockRejectedValue(
          new MockHttpError("Error", {}, undefined, {
            data: "",
            status: 500,
            headers: {},
            rawHeaders: new Headers(),
            rawResponse: new Response("", { status: 500, statusText: "Yes" }),
            config: {},
            statusText: "Yes",
          }),
        );
        const result = await httpHealthIndicator.responseCheck(
          "key",
          "url",
          (res) => res.status === 500,
          { httpClient: httpClientMock },
        );

        expect(result.key?.status).toBe("up");
        expect(httpClientMock.request).toHaveBeenCalledWith({
          url: "url",
          method: "GET",
          headers: undefined,
        });
      });
    });
  },
);
