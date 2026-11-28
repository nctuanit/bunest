import { compareAsc, hmacSha256, sha256 } from "@bunest/core/common";
import type { AwsCredentials } from "../interfaces/provider-transport-options.interface";

export interface SigV4Request {
  method: string;
  path: string;
  query?: string;
  headers: Array<[string, string]>;
  body: string | Buffer;
}

export interface SigV4Options {
  credentials: AwsCredentials;
  region: string;
  service: string;
  date: Date;
}

export interface SigV4Result {
  canonicalRequest: string;
  stringToSign: string;
  authorization: string;
  headers: Record<string, string>;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

/**
 * AWS Signature Version 4 (header form), as the AWS SDKs compute it for services other
 * than S3: the path is normalized (`.`/`..` segments and repeated slashes removed) and
 * percent-encoded per segment, query parameters are decoded, re-encoded and sorted, and
 * header values are trimmed with inner whitespace collapsed.
 */
export function signV4(
  request: SigV4Request,
  options: SigV4Options,
): SigV4Result {
  const { credentials, region, service } = options;
  const amzDate = options.date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const added: Record<string, string> = { "x-amz-date": amzDate };
  if (credentials.sessionToken) {
    added["x-amz-security-token"] = credentials.sessionToken;
  }
  const headers = canonicalHeaders([
    ...request.headers,
    ...Object.entries(added),
  ]);
  const signedHeaders = [...headers.keys()].join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.path),
    canonicalQuery(request.query ?? ""),
    [...headers].map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders,
    sha256(request.body),
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const key = [day, region, service, "aws4_request"].reduce<string | Buffer>(
    (k, part) => hmac(k, part),
    `AWS4${credentials.secretAccessKey}`,
  );
  const signature = hmacSha256(key, stringToSign);
  return {
    canonicalRequest,
    stringToSign,
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: added,
  };
}

function hmac(key: string | Uint8Array, data: string): Buffer {
  const digest = new Bun.CryptoHasher("sha256", key).update(data).digest();
  return Buffer.from(digest.buffer, digest.byteOffset, digest.byteLength);
}

/** RFC 3986 unreserved characters stay; everything else is `%XX` of its UTF-8 bytes. */
function uriEncode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const c = String.fromCharCode(byte);
    out +=
      /[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")
        ? c
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function canonicalPath(path: string): string {
  const segments: string[] = [];
  for (const segment of (path || "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const trailing = segments.length && /\/\.{0,2}$/.test(path) ? "/" : "";
  return uriEncode(`/${segments.join("/")}${trailing}`, true);
}

function canonicalQuery(query: string): string {
  if (!query) {
    return "";
  }
  const pairs: Array<[string, string]> = query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const [key, value] =
        eq === -1 ? [pair, ""] : [pair.slice(0, eq), pair.slice(eq + 1)];
      return [uriEncode(decode(key), false), uriEncode(decode(value), false)];
    });
  pairs.sort(([ak, av], [bk, bv]) => compareAsc(ak, bk) || compareAsc(av, bv));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function decode(component: string): string {
  try {
    return decodeURIComponent(component.replace(/\+/g, "%20"));
  } catch {
    return component;
  }
}

/** Lowercase names in order; values trimmed, runs of whitespace collapsed, repeats joined with commas. */
function canonicalHeaders(
  headers: Array<[string, string]>,
): Map<string, string> {
  const merged = new Map<string, string[]>();
  for (const [name, value] of headers) {
    const key = name.toLowerCase().trim();
    const list = merged.get(key) ?? [];
    list.push(value.replace(/\s+/g, " ").trim());
    merged.set(key, list);
  }
  return new Map(
    [...merged.keys()].sort().map((key) => [key, merged.get(key)!.join(",")]),
  );
}
