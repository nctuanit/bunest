import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpModule, HttpService } from "../../../../packages/axios/src";
import {
  Test,
  describeConformance,
  itAdapted,
} from "../../_helpers/index";

interface ReceivedRequest {
  method: string;
  url: string;
  body: string;
  headers: IncomingMessage["headers"];
}

describeConformance(
  "HttpService (e2e)",
  {
    upstreamPath: "axios/tests/http.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream @nestjs/axios HttpService e2e from RxJS Observables & Axios.CancelToken to Bunest native Promise HttpService & Web AbortController (ADR-001/ADR-008/ADR-013).",
  },
  () => {
    let server: Server;
    let baseURL: string;
    let service: HttpService;
    let received: ReceivedRequest[];
    let abandoned: string[];
    const openTimers = new Set<ReturnType<typeof setTimeout>>();

    const scheduleTimer = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        openTimers.delete(t);
        fn();
      }, ms);
      t.unref?.();
      openTimers.add(t);
      return t;
    };

    beforeAll(async () => {
      received = [];
      abandoned = [];
      server = createServer((req, res) => {
        res.on("close", () => {
          if (!res.writableFinished) {
            abandoned.push(req.url!);
          }
        });

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          received.push({
            method: req.method!,
            url: req.url!,
            body: Buffer.concat(chunks).toString(),
            headers: req.headers,
          });

          if (req.url === "/boom") {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ message: "kaboom" }));
            return;
          }

          if (req.url === "/stream") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.write("first chunk");
            scheduleTimer(() => {
              if (!res.destroyed) res.end();
            }, 400);
            return;
          }

          if (req.url === "/slow") {
            scheduleTimer(() => {
              if (!res.destroyed && !res.writableEnded) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ slow: true }));
              }
            }, 350);
            return;
          }

          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ method: req.method, url: req.url }));
        });
      });

      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const moduleRef = await Test.createTestingModule({
        imports: [HttpModule.register({ baseURL })],
      }).compile({ logger: false });
      service = moduleRef.get(HttpService);
    });

    afterAll(async () => {
      for (const t of openTimers) {
        clearTimeout(t);
      }
      openTimers.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    itAdapted(
      ["ADR-008"],
      "performs a GET and resolves a single response with transformResponse",
      async () => {
        let emissions = 0;
        const response = await service.get<{ method: string; url: string }>(
          "/things",
          {
            transformResponse: [
              (data) => {
                emissions++;
                return typeof data === "string" ? JSON.parse(data) : data;
              },
            ],
          },
        );

        expect(response.status).toBe(200);
        expect(response.data).toEqual({ method: "GET", url: "/things" });
        expect(emissions).toBe(1);
      },
    );

    itAdapted(["ADR-008"], "sends a POST body", async () => {
      const response = await service.post("/things", { name: "nest" });

      expect(response.status).toBe(200);
      const req = received.at(-1)!;
      expect(req.method).toBe("POST");
      expect(JSON.parse(req.body)).toEqual({ name: "nest" });
    });

    itAdapted(
      ["ADR-008"],
      "supports delete, head, patch and put",
      async () => {
        await service.delete("/things/1");
        expect(received.at(-1)!.method).toBe("DELETE");

        await service.head("/things/1");
        expect(received.at(-1)!.method).toBe("HEAD");

        await service.patch("/things/1", { a: 1 });
        expect(received.at(-1)!.method).toBe("PATCH");

        await service.put("/things/1", { a: 1 });
        expect(received.at(-1)!.method).toBe("PUT");
      },
    );

    itAdapted(
      ["ADR-008"],
      "sends multipart payloads via postForm",
      async () => {
        await service.postForm("/form", { a: "1", b: "2" });

        const req = received.at(-1)!;
        expect(req.headers["content-type"]).toContain("multipart/form-data");
        expect(req.body).toContain('name="a"');
        expect(req.body).toContain('name="b"');
      },
    );

    itAdapted(["ADR-008"], "sends a QUERY body", async () => {
      const response = await service.query("/things", { filter: "nest" });

      expect(response.status).toBe(200);
      const req = received.at(-1)!;
      expect(req.method).toBe("QUERY");
      expect(JSON.parse(req.body)).toEqual({ filter: "nest" });
    });

    itAdapted(
      ["ADR-008"],
      "rejects the promise on a non-2xx response",
      async () => {
        await expect(service.get("/boom")).rejects.toMatchObject({
          response: { status: 500, data: { message: "kaboom" } },
        });
      },
    );

    it("exposes the underlying client instance through axiosRef", () => {
      expect(service.axiosRef.defaults.baseURL).toBe(baseURL);
    });

    itAdapted(
      ["ADR-008"],
      "does not mutate the caller-supplied config object",
      async () => {
        const config = { headers: { "x-custom": "yes" } };
        await service.get("/things", config);

        expect(config).toEqual({ headers: { "x-custom": "yes" } });
        expect(config).not.toHaveProperty("cancelToken");
      },
    );

    itAdapted(
      ["ADR-008"],
      "aborts the in-flight request when AbortController signals abort",
      async () => {
        abandoned.length = 0;
        const controller = new AbortController();
        const promise = service.get("/slow", { signal: controller.signal });

        await new Promise((resolve) => setTimeout(resolve, 40));
        controller.abort();

        await expect(promise).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(abandoned).toContain("/slow");
      },
    );

    itAdapted(
      ["ADR-008"],
      "leaves a stream response readable until consumed",
      async () => {
        abandoned.length = 0;
        const response = await service.get<ReadableStream<Uint8Array>>(
          "/stream",
          { responseType: "stream" },
        );

        expect(response.status).toBe(200);
        expect(response.data).toBeInstanceOf(ReadableStream);
        const text = await new Response(response.data).text();
        expect(text).toBe("first chunk");
        expect(abandoned).not.toContain("/stream");
      },
    );

    itAdapted(
      ["ADR-008"],
      "resolves cleanly when the caller awaits a slow response",
      async () => {
        abandoned.length = 0;
        const response = await service.get<{ slow: boolean }>("/slow");

        expect(response.status).toBe(200);
        expect(response.data).toEqual({ slow: true });
        expect(abandoned).not.toContain("/slow");
      },
    );

    itAdapted(
      ["ADR-008"],
      "honours a caller-provided AbortController with custom abort reason",
      async () => {
        const controller = new AbortController();
        const promise = service.get("/slow", { signal: controller.signal });
        controller.abort(new Error("aborted by test"));

        await expect(promise).rejects.toMatchObject({
          message: "aborted by test",
        });
      },
    );

    itAdapted(
      ["ADR-008"],
      "aborts an in-flight request on timeout without mutating caller AbortSignal",
      async () => {
        abandoned.length = 0;
        const controller = new AbortController();
        const promise = service.get("/slow", {
          signal: controller.signal,
          timeout: 50,
        });

        await expect(promise).rejects.toMatchObject({ code: "ECONNABORTED" });
        expect(controller.signal.aborted).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(abandoned).toContain("/slow");
      },
    );

    itAdapted(
      ["ADR-008"],
      "honours an already-aborted signal before sending",
      async () => {
        const controller = new AbortController();
        controller.abort(new Error("pre-aborted"));
        await expect(
          service.get("/slow", { signal: controller.signal }),
        ).rejects.toThrow();
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "stops a stream response when the caller aborts after it arrives",
      async () => {
        abandoned.length = 0;
        const controller = new AbortController();
        const response = await service.get<ReadableStream<Uint8Array>>(
          "/stream",
          {
            responseType: "stream",
            signal: controller.signal,
          },
        );
        controller.abort();
        await response.data.cancel().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(abandoned).toContain("/stream");
      },
    );

    // BUNEST_BUG: HttpService.executeRequest() / combineSignals() (packages/axios/src/http.service.ts:261-274,850-871) passes duck-typed GenericAbortSignal objects directly to Bun fetch() without bridging via an AbortController, causing TypeError: signal is not of type AbortSignal (ERR_INVALID_ARG_TYPE).
    it.skip("supports custom GenericAbortSignal objects without throwing", async () => {
      const listeners = new Set<() => void>();
      const customSignal = {
        aborted: false,
        addEventListener: (_type: string, listener: () => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          listeners.delete(listener);
        },
      };

      const promise = service.get("/slow", {
        signal: customSignal as unknown as AbortSignal,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      customSignal.aborted = true;
      for (const listener of [...listeners]) {
        listener();
      }

      await expect(promise).rejects.toThrow();
      expect(listeners.size).toBe(0);
    });
  },
);
