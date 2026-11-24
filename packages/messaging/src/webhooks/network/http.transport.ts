import { isIp as isIP } from "@bunest/core";
import { WebhookDestinationBlockedError } from "../errors/webhook-destination-blocked.error";
import type {
  HttpWebhookTransportOptions,
  ResolvedAddress,
} from "../interfaces/http-webhook-transport-options.interface";
import type {
  WebhookRequest,
  WebhookTransportResponse,
  WebhookTransportSendOptions,
} from "../interfaces/webhook-transport.interface";
import { WebhookTransport } from "../transports/webhook.transport";
import { AddressPolicy } from "./address.policy";
import {
  checkDestination,
  isLocalhostName,
  socketHost,
} from "./destination.util";

const DEFAULT_MAX_RESPONSE_SIZE = 4_096;

/** Normalizes custom certificate authorities for Bun native `fetch(..., { tls: { ca } })`. */
export function trustedCertificates(
  ca: NonNullable<HttpWebhookTransportOptions["ca"]>,
): (string | Buffer)[] {
  return Array.isArray(ca) ? [...ca] : [ca as string | Buffer];
}

/**
 * The default transport: one POST per attempt over native Bun `fetch()`, guarded
 * against server-side request forgery.
 *
 * - https only (`allowHttp` for development); no credentials in the URL.
 * - The host is resolved here, once, and **every** address it resolves to must be allowed
 *   (see `AddressPolicy`); an IP literal is checked as is.
 * - The request connects directly to the pinned address that was checked, passing the
 *   original `Host` header (and TLS `serverName` for SNI/cert verification on `https:`),
 *   preventing DNS rebinding.
 * - Redirects are never followed (`redirect: 'manual'`): a 3xx is a failed attempt.
 * - At most `maxResponseSize` bytes of the body are read; then the stream is canceled.
 */
export class HttpWebhookTransport extends WebhookTransport {
  private readonly policy: AddressPolicy;
  private readonly allowHttp: boolean;
  private readonly maxResponseSize: number;
  private readonly resolve: (
    hostname: string,
  ) => Promise<readonly ResolvedAddress[]>;
  private readonly ca?: (string | Buffer)[];

  constructor(options: HttpWebhookTransportOptions = {}) {
    super();
    this.policy = new AddressPolicy(options);
    this.allowHttp = options.allowHttp === true;
    this.maxResponseSize = options.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
    if (!Number.isInteger(this.maxResponseSize) || this.maxResponseSize < 0) {
      throw new TypeError(
        `WebhooksModule: delivery.maxResponseSize must be a whole number of bytes (got ${options.maxResponseSize})`,
      );
    }
    this.resolve =
      options.lookup ??
      (async (hostname) => {
        const records = await Bun.dns.lookup(hostname);
        return records.map((r) => ({
          address: r.address,
          family: r.family === 6 ? 6 : 4,
        }));
      });
    this.ca =
      options.ca === undefined ? undefined : trustedCertificates(options.ca);
  }

  override async send(
    request: WebhookRequest,
    { signal }: WebhookTransportSendOptions,
  ): Promise<WebhookTransportResponse> {
    signal.throwIfAborted();
    const checked = checkDestination(request.url, this.policy, this.allowHttp);
    if (!checked.url) {
      throw new WebhookDestinationBlockedError(request.url, checked.reason);
    }
    const url = checked.url;
    const host = socketHost(url);
    const pinned = await this.pin(request.url, host, signal);
    return this.post(url, host, pinned, request, signal);
  }

  /** The one address the socket may connect to, after every address of the host passed the policy. */
  private async pin(
    raw: string,
    host: string,
    signal: AbortSignal,
  ): Promise<ResolvedAddress> {
    const literal = isIP(host);
    if (literal === 4 || literal === 6) {
      return { address: host, family: literal };
    }
    if (isLocalhostName(host)) {
      // checkDestination() allowed loopback; never ask a resolver what localhost is.
      return { address: "127.0.0.1", family: 4 };
    }
    const addresses = await abortable(this.resolve(host), signal);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw Object.assign(new Error(`${host} did not resolve to any address`), {
        code: "ENOTFOUND",
      });
    }
    for (const { address } of addresses) {
      const verdict = this.policy.check(address);
      if (!verdict.allowed) {
        throw new WebhookDestinationBlockedError(
          raw,
          `${host} resolves to ${address}, ${verdict.reason}`,
          address,
        );
      }
    }
    const first = addresses[0]!;
    return {
      address: first.address,
      family: isIP(first.address) === 6 ? 6 : 4,
    };
  }

  private async post(
    url: URL,
    host: string,
    pinned: ResolvedAddress,
    request: WebhookRequest,
    signal: AbortSignal,
  ): Promise<WebhookTransportResponse> {
    const pinnedHost =
      pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
    const targetUrl = `${url.protocol}//${pinnedHost}${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}`;
    const bodyBytes = Buffer.from(request.body, "utf8");
    const secure = url.protocol === "https:";

    const init: RequestInit & {
      tls?: { ca?: (string | Buffer)[]; serverName?: string };
    } = {
      method: "POST",
      headers: {
        ...request.headers,
        host: url.host,
        "content-length": String(bodyBytes.length),
        connection: "close",
      },
      body: bodyBytes,
      redirect: "manual",
      signal,
    };

    if (secure) {
      const tlsOptions: { ca?: (string | Buffer)[]; serverName?: string } = {};
      if (!isIP(host)) {
        tlsOptions.serverName = host;
      }
      if (this.ca) {
        tlsOptions.ca = this.ca;
      }
      if (tlsOptions.serverName || tlsOptions.ca) {
        init.tls = tlsOptions;
      }
    }

    let response: Response;
    try {
      response = await fetch(targetUrl, init);
    } catch (error) {
      throw signal.aborted ? signal.reason : error;
    }

    const headers = flattenHeaders(response.headers);
    const body = await readCappedBody(response, this.maxResponseSize, signal);

    return {
      statusCode: response.status,
      headers,
      body,
    };
  }
}

async function readCappedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (maxBytes === 0 || !response.body) {
    if (response.body) {
      await response.body.cancel().catch(() => undefined);
    }
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;

  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const room = maxBytes - size;
      if (room > 0) {
        chunks.push(value.subarray(0, room));
      }
      size += value.byteLength;
      if (size >= maxBytes) {
        cut = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw signal.aborted ? signal.reason : error;
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks);
  // A cut body may end mid-character: streaming TextDecoder drops incomplete trailing bytes instead of emitting U+FFFD.
  return cut
    ? new TextDecoder("utf-8").decode(bytes, { stream: true })
    : new TextDecoder("utf-8").decode(bytes);
}

function flattenHeaders(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
