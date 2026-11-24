import { afterAll, beforeAll, expect } from "bun:test";
import {
  HttpClient,
  HttpClientModule,
  HttpResponseError,
  HttpTimeoutError,
} from "../../../../packages/core/src/client";
import {
  Test,
  describeConformance,
  itAdapted,
} from "../../_helpers/index";

interface ReceivedRequest {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

describeConformance(
  "HttpClient (axios HttpService e2e parity)",
  {
    upstreamPath: "axios/tests/http.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-017"],
    notes:
      "Adapts upstream @nestjs/axios HttpService e2e from RxJS Observables & Axios.CancelToken to Bunest native Promise HttpClient & Web AbortController (ADR-001/ADR-008/ADR-017).",
  },
  () => {
    let server: ReturnType<typeof Bun.serve>;
    let baseUrl: string;
    let client: HttpClient;
    let received: ReceivedRequest[];
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
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const parsedUrl = new URL(req.url);
          const pathname = parsedUrl.pathname + parsedUrl.search;
          const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
          const headers: Record<string, string> = {};
          req.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
          });
          received.push({
            method: req.method,
            url: pathname,
            body,
            headers,
          });

          if (pathname === "/boom") {
            return new Response(JSON.stringify({ message: "kaboom" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }

          if (pathname === "/stream") {
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first chunk"));
                scheduleTimer(() => {
                  try {
                    controller.close();
                  } catch {
                    // already cancelled
                  }
                }, 120);
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { "content-type": "text/plain" },
            });
          }

          if (pathname === "/slow") {
            await new Promise<void>((resolve) => {
              scheduleTimer(resolve, 250);
            });
            return new Response(JSON.stringify({ slow: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          return new Response(
            JSON.stringify({ method: req.method, url: pathname }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      });

      baseUrl = `http://127.0.0.1:${server.port}`;

      const moduleRef = await Test.createTestingModule({
        imports: [HttpClientModule.register({ baseUrl })],
      }).compile({ logger: false });
      client = moduleRef.get(HttpClient);
    });

    afterAll(async () => {
      for (const t of openTimers) {
        clearTimeout(t);
      }
      openTimers.clear();
      server?.stop(true);
    });

    itAdapted(
      ["ADR-008"],
      "performs a GET and resolves a single response",
      async () => {
        const response = await client.get<{ method: string; url: string }>(
          "/things",
        );

        expect(response.status).toBe(200);
        expect(response.data).toEqual({ method: "GET", url: "/things" });
      },
    );

    itAdapted(["ADR-008"], "sends a POST body", async () => {
      const response = await client.post("/things", {
        json: { name: "nest" },
      });

      expect(response.status).toBe(200);
      const req = received.at(-1)!;
      expect(req.method).toBe("POST");
      expect(JSON.parse(req.body)).toEqual({ name: "nest" });
    });

    itAdapted(
      ["ADR-008"],
      "supports delete, head, patch and put",
      async () => {
        await client.delete("/things/1");
        expect(received.at(-1)!.method).toBe("DELETE");

        await client.head("/things/1");
        expect(received.at(-1)!.method).toBe("HEAD");

        await client.patch("/things/1", { json: { a: 1 } });
        expect(received.at(-1)!.method).toBe("PATCH");

        await client.put("/things/1", { json: { a: 1 } });
        expect(received.at(-1)!.method).toBe("PUT");
      },
    );

    itAdapted(
      ["ADR-008"],
      "sends multipart payloads via FormData",
      async () => {
        const form = new FormData();
        form.append("a", "1");
        form.append("b", "2");
        await client.post("/form", { body: form });

        const req = received.at(-1)!;
        expect(req.headers["content-type"]).toContain("multipart/form-data");
        expect(req.body).toContain('name="a"');
        expect(req.body).toContain('name="b"');
      },
    );

    itAdapted(
      ["ADR-008"],
      "rejects the promise on a non-2xx response",
      async () => {
        const err = await client.get("/boom").catch((e) => e);
        expect(err).toBeInstanceOf(HttpResponseError);
        expect((err as HttpResponseError).status).toBe(500);
        expect((err as HttpResponseError).body).toEqual({ message: "kaboom" });
      },
    );

    itAdapted(
      ["ADR-008"],
      "does not mutate the caller-supplied options object",
      async () => {
        const config = { headers: { "x-custom": "yes" } };
        await client.get("/things", config);

        expect(config).toEqual({ headers: { "x-custom": "yes" } });
        expect(config).not.toHaveProperty("cancelToken");
      },
    );

    itAdapted(
      ["ADR-008"],
      "aborts the in-flight request when AbortController signals abort",
      async () => {
        const controller = new AbortController();
        const promise = client.get("/slow", { signal: controller.signal });

        await new Promise((resolve) => setTimeout(resolve, 40));
        controller.abort();

        await expect(promise).rejects.toThrow();
      },
    );

    itAdapted(
      ["ADR-008"],
      "leaves a stream response readable until consumed",
      async () => {
        const response = await client.get("/stream", {
          responseType: "stream",
        });

        expect(response.status).toBe(200);
        expect(response.data).toBeInstanceOf(ReadableStream);
        const text = await new Response(response.data).text();
        expect(text).toBe("first chunk");
      },
    );

    itAdapted(
      ["ADR-008"],
      "resolves cleanly when the caller awaits a slow response",
      async () => {
        const response = await client.get<{ slow: boolean }>("/slow");

        expect(response.status).toBe(200);
        expect(response.data).toEqual({ slow: true });
      },
    );

    itAdapted(
      ["ADR-008"],
      "honours a caller-provided AbortController with custom abort reason",
      async () => {
        const controller = new AbortController();
        const promise = client.get("/slow", { signal: controller.signal });
        controller.abort(new Error("aborted by test"));

        await expect(promise).rejects.toThrow();
      },
    );

    itAdapted(
      ["ADR-008"],
      "aborts an in-flight request on timeout without mutating caller AbortSignal",
      async () => {
        const controller = new AbortController();
        const promise = client.get("/slow", {
          signal: controller.signal,
          timeout: 50,
        });

        const err = await promise.catch((e) => e);
        expect(err).toBeInstanceOf(HttpTimeoutError);
        expect(controller.signal.aborted).toBe(false);
      },
    );

    itAdapted(
      ["ADR-008"],
      "honours an already-aborted signal before sending",
      async () => {
        const controller = new AbortController();
        controller.abort(new Error("pre-aborted"));
        await expect(
          client.get("/slow", { signal: controller.signal }),
        ).rejects.toThrow();
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "stops a stream response when the caller aborts after it arrives",
      async () => {
        const controller = new AbortController();
        const response = await client.get("/stream", {
          responseType: "stream",
          signal: controller.signal,
        });
        controller.abort();
        await response.data.cancel().catch(() => {});
        expect(controller.signal.aborted).toBe(true);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "supports custom GenericAbortSignal objects without throwing",
      async () => {
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

        const promise = client.get("/slow", {
          signal: customSignal as unknown as AbortSignal,
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        customSignal.aborted = true;
        for (const listener of [...listeners]) {
          listener();
        }

        await expect(promise).rejects.toThrow();
        expect(listeners.size).toBe(0);
      },
    );
  },
);
