import { redactUrl } from "../utils/url.util";
import { HttpClientError } from "./http-client.error";

/**
 * The request failed before a complete response arrived: DNS, a refused or
 * reset connection, TLS, a redirect that `redirect: 'error'` refused. `cause`
 * has the details, e.g. `cause.code === 'ECONNREFUSED'`.
 */
export class HttpNetworkError extends HttpClientError {
  constructor(init: { method: string; url: string; cause: unknown }) {
    const detail = init.cause as
      | { code?: unknown; message?: unknown }
      | null
      | undefined;
    const reason =
      typeof detail?.code === "string"
        ? detail.code
        : typeof detail?.message === "string"
          ? detail.message
          : "network error";
    super(`${init.method} ${redactUrl(init.url)} failed: ${reason}`, init);
  }
}
