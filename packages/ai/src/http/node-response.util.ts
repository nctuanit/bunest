import type { HttpServerResponseLike as ServerResponse } from "@bunest/core";
import { AiConfigurationError } from "../errors/ai.errors";

interface FastifyReplyLike {
  hijack(): void;
  getHeaders(): Record<string, string | string[] | number | undefined>;
  raw: ServerResponse;
}

function isFastifyReply(value: unknown): value is FastifyReplyLike {
  const reply = value as FastifyReplyLike | null | undefined;
  return (
    typeof reply?.hijack === "function" &&
    typeof reply.raw?.writeHead === "function"
  );
}

function isServerResponse(value: unknown): value is ServerResponse {
  const response = value as ServerResponse | null | undefined;
  return (
    typeof response?.writeHead === "function" &&
    typeof response.on === "function"
  );
}

/**
 * The Node response behind the platform's: Express's and the Node adapter's are Node responses;
 * a Fastify reply is hijacked when the body starts (`open()`), with the headers set on it so far copied to its raw response.
 */
export function toNodeResponse(response: unknown): {
  res: ServerResponse;
  open(): void;
} {
  if (isFastifyReply(response)) {
    return {
      res: response.raw,
      open: () => {
        const headers = response.getHeaders?.() ?? {};
        response.hijack();
        for (const [name, value] of Object.entries(headers)) {
          if (value !== undefined && !response.raw.hasHeader?.(name)) {
            response.raw.setHeader(name, value);
          }
        }
      },
    };
  }
  if (isServerResponse(response)) {
    return { res: response, open: () => {} };
  }
  throw new AiConfigurationError(
    "Pass the response that @Res() injects (Node ServerResponse or Fastify reply) to pipeUIMessageStreamToResponse() and pipeTextStreamToResponse().",
  );
}

/**
 * Writes `response` to the Node response: status and headers, then the body as it streams, respecting backpressure.
 * A client that goes away cancels the body (which aborts the call that produces it).
 */
export async function writeWebResponse(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  if (res.headersSent || res.destroyed) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") {
      headers[name] = value;
    }
  });
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  if (cookies.length > 0) {
    headers["set-cookie"] = cookies;
  }
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.writeHead(response.status);
  if (!response.body) {
    res.end();
    return;
  }
  res.flushHeaders?.();
  const reader = response.body.getReader();
  let gone = false;
  let release: (() => void) | undefined;
  const onClose = () => {
    if (!res.writableFinished) {
      gone = true;
      release?.();
      reader.cancel().catch(() => {});
    }
  };
  res.once("close", onClose);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done || gone) {
        break;
      }
      if (!res.write(next.value)) {
        await new Promise<void>((resolve) => {
          release = resolve;
          res.once("drain", resolve);
        });
        release = undefined;
      }
    }
    if (gone) {
      res.destroy();
    } else {
      res.end();
    }
  } catch {
    res.destroy();
  } finally {
    res.off("close", onClose);
  }
}
