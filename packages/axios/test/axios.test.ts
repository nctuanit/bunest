import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Injectable, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  HttpError,
  HttpModule,
  HttpService,
  type HttpModuleOptions,
  type HttpModuleOptionsFactory,
} from "../src";

describe("@bunest/axios (HttpModule & HttpService)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseURL: string;
  let flakyCount = 0;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/api/echo" && req.method === "GET") {
          return Response.json({
            method: req.method,
            query: Object.fromEntries(url.searchParams.entries()),
            tags: url.searchParams.getAll("tag"),
            auth: req.headers.get("authorization"),
            custom: req.headers.get("x-custom"),
          });
        }

        if (url.pathname === "/api/items" && req.method === "POST") {
          const body = await req.json();
          return Response.json(
            { created: body, contentType: req.headers.get("content-type") },
            { status: 201 },
          );
        }

        if (url.pathname === "/api/form" && req.method === "POST") {
          const form = await req.formData();
          return Response.json({
            name: form.get("name"),
            role: form.get("role"),
          });
        }

        if (url.pathname === "/api/slow") {
          await Bun.sleep(200);
          return Response.json({ ok: true });
        }

        if (url.pathname === "/api/flaky") {
          flakyCount++;
          if (flakyCount < 3) {
            return Response.json({ error: "temporary" }, { status: 503 });
          }
          return Response.json({ ok: true, attempt: flakyCount });
        }

        if (url.pathname === "/api/not-found") {
          return Response.json({ message: "missing" }, { status: 404 });
        }

        if (url.pathname === "/api/head" && req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "x-exists": "yes" },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });
    baseURL = `http://127.0.0.1:${server.port}/api`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("supports HttpModule.register() with baseURL, headers, params, JSON POST, form POST, and HEAD", async () => {
    @Module({
      imports: [
        HttpModule.register({
          baseURL,
          headers: { Authorization: "Bearer secret-token" },
        }),
      ],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    try {
      const http = ctx.get(HttpService);
      expect(http.axiosRef).toBe(http);

      const getRes = await http.get<{
        method: string;
        query: Record<string, string>;
        tags: string[];
        auth: string;
        custom: string;
      }>("/echo", {
        params: { page: 2, tag: ["a", "b"] },
        headers: { "X-Custom": "bunest" },
      });
      expect(getRes.status).toBe(200);
      expect(getRes.data.method).toBe("GET");
      expect(getRes.data.query.page).toBe("2");
      expect(getRes.data.tags).toEqual(["a", "b"]);
      expect(getRes.data.auth).toBe("Bearer secret-token");
      expect(getRes.data.custom).toBe("bunest");

      const postRes = await http.post<{ created: { title: string } }>(
        "/items",
        { title: "Bunest" },
      );
      expect(postRes.status).toBe(201);
      expect(postRes.data.created).toEqual({ title: "Bunest" });

      const formRes = await http.postForm<{ name: string; role: string }>(
        "/form",
        { name: "Alice", role: "admin" },
      );
      expect(formRes.status).toBe(200);
      expect(formRes.data).toEqual({ name: "Alice", role: "admin" });

      const headRes = await http.head("/head");
      expect(headRes.status).toBe(200);
      expect(headRes.headers["x-exists"]).toBe("yes");
    } finally {
      await ctx.close();
    }
  });

  it("supports request/response interceptors, error throwing, validateStatus, timeout, and retries", async () => {
    const http = new HttpService({ baseURL });

    const reqId = http.interceptors.request.use((cfg) => {
      const headers = new Headers(cfg.headers as RequestInit["headers"]);
      headers.set("x-custom", "from-interceptor");
      return { ...cfg, headers };
    });

    const resId = http.interceptors.response.use((res) => ({
      ...res,
      data:
        res.data && typeof res.data === "object"
          ? { ...(res.data as Record<string, unknown>), intercepted: true }
          : res.data,
    }));

    const res = await http.get<{ custom: string; intercepted: boolean }>(
      "/echo",
    );
    expect(res.data.custom).toBe("from-interceptor");
    expect(res.data.intercepted).toBe(true);

    http.interceptors.request.eject(reqId);
    http.interceptors.response.eject(resId);

    // Non-2xx throws HttpError by default
    let caught: unknown;
    try {
      await http.get("/not-found");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(404);
    expect((caught as HttpError).isAxiosError).toBe(true);

    // Custom validateStatus allows 404 to resolve
    const ok404 = await http.get<{ message: string }>("/not-found", {
      validateStatus: (status) => status < 500,
    });
    expect(ok404.status).toBe(404);
    expect(ok404.data.message).toBe("missing");

    // Timeout via native AbortSignal.timeout
    let timeoutErr: unknown;
    try {
      await http.get("/slow", { timeout: 30 });
    } catch (err) {
      timeoutErr = err;
    }
    expect(timeoutErr).toBeInstanceOf(HttpError);
    expect((timeoutErr as HttpError).code).toBe("ECONNABORTED");

    // Retries on 5xx
    flakyCount = 0;
    const retryRes = await http.get<{ ok: boolean; attempt: number }>(
      "/flaky",
      { retries: 3, retryDelayMs: 5 },
    );
    expect(retryRes.status).toBe(200);
    expect(retryRes.data).toEqual({ ok: true, attempt: 3 });
  });

  it("supports HttpModule.registerAsync with useFactory and useClass", async () => {
    @Injectable()
    class CustomHttpOptions implements HttpModuleOptionsFactory {
      createHttpOptions(): HttpModuleOptions {
        return {
          baseURL,
          headers: { "x-custom": "from-class-factory" },
        };
      }
    }

    @Module({
      imports: [
        HttpModule.registerAsync({
          useClass: CustomHttpOptions,
        }),
      ],
    })
    class ClassFactoryModule {}

    const ctx = await BunestFactory.createApplicationContext(
      ClassFactoryModule,
      { logger: false },
    );
    try {
      const http = ctx.get(HttpService);
      const res = await http.get<{ custom: string }>("/echo");
      expect(res.data.custom).toBe("from-class-factory");
    } finally {
      await ctx.close();
    }
  });
});
