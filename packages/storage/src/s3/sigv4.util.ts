import type { S3Credentials } from "../interfaces/storage-types";
import { encodeRfc3986 } from "../utils/keys.util";

export const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function hmac(key: string | Uint8Array, data: string): Buffer {
  const bytes = new Bun.CryptoHasher("sha256", key).update(data).digest();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** `20150830T123600Z` */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function dateStamp(date: Date): string {
  return amzDate(date).slice(0, 8);
}

/**
 * The canonical query string: every name and value RFC 3986-encoded, sorted by name, then
 * by value. Takes decoded pairs.
 */
export function canonicalQuery(pairs: Iterable<[string, string]>): string {
  const encoded: Array<[string, string]> = [];
  for (const [k, v] of pairs) {
    encoded.push([encodeRfc3986(k), encodeRfc3986(v)]);
  }
  encoded.sort((a, b) =>
    a[0] === b[0]
      ? a[1] < b[1]
        ? -1
        : a[1] > b[1]
          ? 1
          : 0
      : a[0] < b[0]
        ? -1
        : 1,
  );
  return encoded.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Canonical headers: names lowercased and sorted, values trimmed with inner runs of
 * whitespace collapsed to one space, repeated headers joined with commas.
 */
export function canonicalHeaders(headers: Iterable<[string, string]>): {
  canonical: string;
  signed: string;
} {
  const grouped = new Map<string, string[]>();
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase().trim();
    const value = rawValue.trim().replace(/\s+/g, " ");
    const existing = grouped.get(name);
    if (existing) {
      existing.push(value);
    } else {
      grouped.set(name, [value]);
    }
  }
  const names = [...grouped.keys()].sort();
  const canonical = names
    .map((name) => `${name}:${grouped.get(name)!.join(",")}\n`)
    .join("");
  return {
    canonical,
    signed: names.join(";"),
  };
}

export interface CanonicalRequestInput {
  method: string;
  path: string;
  query: Iterable<[string, string]>;
  headers: Iterable<[string, string]>;
  payloadHash: string;
}

export function canonicalRequest(input: CanonicalRequestInput): {
  request: string;
  signedHeaders: string;
} {
  const { canonical, signed } = canonicalHeaders(input.headers);
  const request = [
    input.method.toUpperCase(),
    input.path || "/",
    canonicalQuery(input.query),
    canonical,
    signed,
    input.payloadHash,
  ].join("\n");
  return { request, signedHeaders: signed };
}

export function credentialScope(
  date: Date,
  region: string,
  service: string,
): string {
  return `${dateStamp(date)}/${region}/${service}/aws4_request`;
}

export function stringToSign(
  request: string,
  date: Date,
  scope: string,
): string {
  return ["AWS4-HMAC-SHA256", amzDate(date), scope, sha256Hex(request)].join(
    "\n",
  );
}

export function signature(
  secretAccessKey: string,
  date: Date,
  region: string,
  service: string,
  toSign: string,
): string {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp(date));
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  return hmac(kSigning, toSign).toString("hex");
}

export interface SignRequestInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  credentials: S3Credentials;
  region: string;
  service?: string;
  date?: Date;
}

/** Header-based SigV4: returns the headers to send, `authorization` included. */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const service = input.service ?? "s3";
  const date = input.date ?? new Date();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    headers[k.toLowerCase()] = v;
  }
  headers["host"] = input.url.host;
  headers["x-amz-date"] = amzDate(date);
  headers["x-amz-content-sha256"] = input.payloadHash;
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const queryPairs: Array<[string, string]> = [];
  input.url.searchParams.forEach((v, k) => {
    queryPairs.push([k, v]);
  });

  const { request, signedHeaders } = canonicalRequest({
    method: input.method,
    path: input.url.pathname,
    query: queryPairs,
    headers: Object.entries(headers),
    payloadHash: input.payloadHash,
  });

  const scope = credentialScope(date, input.region, service);
  const toSign = stringToSign(request, date, scope);
  const sig = signature(
    input.credentials.secretAccessKey,
    date,
    input.region,
    service,
    toSign,
  );

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

  return headers;
}

export interface PresignInput {
  method: "GET" | "PUT";
  url: URL;
  headers?: Record<string, string>;
  expiresInSeconds: number;
  credentials: S3Credentials;
  region: string;
  service?: string;
  date?: Date;
}

/** Query-string SigV4 (a presigned URL), with an unsigned payload. */
export function presignUrl(input: PresignInput): URL {
  const service = input.service ?? "s3";
  const date = input.date ?? new Date();
  const scope = credentialScope(date, input.region, service);
  const signedHeadersMap: Record<string, string> = {
    host: input.url.host,
  };
  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) {
      signedHeadersMap[k.toLowerCase()] = v;
    }
  }
  const { signed } = canonicalHeaders(Object.entries(signedHeadersMap));

  const out = new URL(input.url);
  out.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  out.searchParams.set(
    "X-Amz-Credential",
    `${input.credentials.accessKeyId}/${scope}`,
  );
  out.searchParams.set("X-Amz-Date", amzDate(date));
  out.searchParams.set(
    "X-Amz-Expires",
    String(Math.max(1, Math.floor(input.expiresInSeconds))),
  );
  out.searchParams.set("X-Amz-SignedHeaders", signed);
  if (input.credentials.sessionToken) {
    out.searchParams.set(
      "X-Amz-Security-Token",
      input.credentials.sessionToken,
    );
  }

  const queryPairs: Array<[string, string]> = [];
  out.searchParams.forEach((v, k) => {
    queryPairs.push([k, v]);
  });

  const { request } = canonicalRequest({
    method: input.method,
    path: out.pathname,
    query: queryPairs,
    headers: Object.entries(signedHeadersMap),
    payloadHash: UNSIGNED_PAYLOAD,
  });

  const toSign = stringToSign(request, date, scope);
  const sig = signature(
    input.credentials.secretAccessKey,
    date,
    input.region,
    service,
    toSign,
  );
  out.searchParams.set("X-Amz-Signature", sig);
  return out;
}
