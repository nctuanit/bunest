import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { FetchCapable } from "./interfaces/testing.interface";

function readNodeRequestBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (typeof chunk === "string") {
        chunks.push(new TextEncoder().encode(chunk));
      } else {
        chunks.push(
          chunk instanceof Uint8Array
            ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : new Uint8Array(chunk),
        );
      }
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(new Uint8Array(0));
        return;
      }
      if (chunks.length === 1) {
        resolve(chunks[0]!);
        return;
      }
      const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      resolve(merged);
    });
    req.on("error", reject);
  });
}

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = req.rawHeaders;
  if (Array.isArray(raw) && raw.length >= 2) {
    for (let i = 0; i < raw.length - 1; i += 2) {
      const name = raw[i];
      const value = raw[i + 1];
      if (name !== undefined && value !== undefined) {
        headers.append(name, value);
      }
    }
    return headers;
  }

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function getSetCookiesFromHeaders(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

async function writeWebResponseToNode(
  webRes: Response,
  nodeRes: ServerResponse,
  method: string,
): Promise<void> {
  nodeRes.statusCode = webRes.status;
  if (webRes.statusText) {
    nodeRes.statusMessage = webRes.statusText;
  }

  const setCookies = getSetCookiesFromHeaders(webRes.headers);
  if (setCookies.length > 0) {
    nodeRes.setHeader("set-cookie", setCookies);
  }

  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      return;
    }
    nodeRes.setHeader(key, value);
  });

  if (method === "HEAD" || !webRes.body) {
    nodeRes.end();
    return;
  }

  const reader = webRes.body.getReader();
  const onClose = () => {
    void reader.cancel().catch(() => {});
  };
  nodeRes.once("close", onClose);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.byteLength > 0) {
        const canContinue = nodeRes.write(value);
        if (!canContinue && !nodeRes.destroyed) {
          await new Promise<void>((resolve) => {
            nodeRes.once("drain", resolve);
            nodeRes.once("close", resolve);
          });
        }
      }
      if (nodeRes.destroyed) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    nodeRes.removeListener("close", onClose);
    if (!nodeRes.writableEnded) {
      nodeRes.end();
    }
  }
}

/**
 * Optional Node `http.Server` bridge (lives exclusively inside `@bunest/testing`
 * to keep `@bunest/core` and `@bunest/http` strictly Bun-native per ADR-001).
 *
 * Allows passing any Bunest `BunestApplication` / `FetchCapable` to legacy tools
 * expecting a Node `http.Server` (such as npm `supertest(createNodeHttpServer(app))`).
 * Faithfully forwards binary payloads, streams, and multiple `Set-Cookie` headers.
 */
export function createNodeHttpServer(app: FetchCapable): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const abortController = new AbortController();
    const onAborted = () => abortController.abort();
    req.once("aborted", onAborted);
    res.once("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    const handle = async (): Promise<void> => {
      const method = (req.method ?? "GET").toUpperCase();
      const host = req.headers.host ?? "127.0.0.1";
      const path = req.url ?? "/";
      const url = `http://${host}${path.startsWith("/") ? path : `/${path}`}`;
      const headers = toWebHeaders(req);

      const init: RequestInit = {
        method,
        headers,
        signal: abortController.signal,
      };

      if (method !== "GET" && method !== "HEAD") {
        const bodyBytes = await readNodeRequestBody(req);
        if (bodyBytes.byteLength > 0) {
          init.body = bodyBytes;
        }
      }

      const webReq = new Request(url, init);
      const webRes = await app.fetch(webReq);
      await writeWebResponseToNode(webRes, res, method);
    };

    void handle()
      .catch((error: unknown) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              statusCode: 500,
              error: "Internal Server Error",
              message:
                error instanceof Error ? error.message : "Internal server error",
            }),
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      })
      .finally(() => {
        req.removeListener("aborted", onAborted);
      });
  });
}
