import {
  definedOnly,
  isString,
  timingSafeEqualBytes,
} from "@bunest/core/common";
import { StorageSignedUrlError } from "../errors";
import type {
  StorageSignedUrlClaims,
  StorageSignedUrlOptions,
} from "../interfaces/storage-types";

export type SignedUrlQuery =
  string | URL | URLSearchParams | Record<string, unknown>;

const PARAMS = {
  key: "key",
  expires: "expires",
  method: "method",
  contentType: "type",
  contentLength: "length",
  contentDisposition: "disposition",
  signature: "signature",
} as const;

function toUrl(value: unknown): URL | undefined {
  if (!(value instanceof URL) && !isString(value)) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function toSearchParams(input: SignedUrlQuery): URLSearchParams {
  if (input instanceof URLSearchParams) {
    return input;
  }
  if (input instanceof URL) {
    return input.searchParams;
  }
  if (typeof input === "string") {
    const question = input.indexOf("?");
    return new URLSearchParams(
      question === -1 ? "" : input.slice(question + 1),
    );
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(input ?? {})) {
    if (typeof value === "string") {
      params.append(name, value);
    } else if (value !== undefined) {
      params.append(name, "\u0000invalid");
    }
  }
  return params;
}

export class UrlSigner {
  private readonly baseUrl: URL;
  private readonly keys: Buffer[];

  constructor(options: StorageSignedUrlOptions, owner: string) {
    const base = toUrl(options?.baseUrl);
    if (
      !base ||
      !/^https?:$/.test(base.protocol) ||
      base.search ||
      base.hash ||
      base.username
    ) {
      throw new TypeError(
        `${owner} \`signedUrls.baseUrl\` must be an absolute http(s) URL without a query, such as "https://api.example.com/files"`,
      );
    }
    this.baseUrl = base;
    if (!Array.isArray(options.keys) || options.keys.length === 0) {
      throw new TypeError(
        `${owner} \`signedUrls.keys\` needs at least one key (the first signs, all verify)`,
      );
    }
    this.keys = options.keys.map((key, index) => {
      if (typeof key === "string" && key.length >= 32) {
        return Buffer.from(key, "utf8");
      }
      if (Buffer.isBuffer(key) && key.length >= 32) {
        return key;
      }
      throw new TypeError(
        `${owner} \`signedUrls.keys[${index}]\` must be a string of at least 32 characters or a Buffer of at least 32 bytes`,
      );
    });
  }

  sign(claims: StorageSignedUrlClaims): string {
    const url = new URL(this.baseUrl);
    const expires = Math.floor(claims.expiresAt.getTime() / 1000);
    url.searchParams.set(PARAMS.key, claims.key);
    url.searchParams.set(PARAMS.expires, String(expires));
    if (claims.method !== "GET") {
      url.searchParams.set(PARAMS.method, claims.method);
    }
    if (claims.contentType !== undefined) {
      url.searchParams.set(PARAMS.contentType, claims.contentType);
    }
    if (claims.contentLength !== undefined) {
      url.searchParams.set(PARAMS.contentLength, String(claims.contentLength));
    }
    if (claims.contentDisposition !== undefined) {
      url.searchParams.set(
        PARAMS.contentDisposition,
        claims.contentDisposition,
      );
    }
    url.searchParams.set(
      PARAMS.signature,
      this.mac(this.keys[0]!, claims, expires).toString("base64url"),
    );
    return url.toString();
  }

  /** Checks the signature first, so only an authentic URL can report `expired`. */
  verify(
    input: SignedUrlQuery,
    method: "GET" | "PUT",
    now = Date.now(),
  ): StorageSignedUrlClaims {
    const query = toSearchParams(input);
    const single = (name: string): string | undefined => {
      const values = query.getAll(name);
      if (values.length > 1) {
        throw new StorageSignedUrlError("invalid");
      }
      return values[0];
    };

    const key = single(PARAMS.key);
    const expiresText = single(PARAMS.expires);
    const signature = single(PARAMS.signature);
    if (!key || !expiresText || !signature) {
      throw new StorageSignedUrlError("missing");
    }
    if (!/^\d{1,12}$/.test(expiresText)) {
      throw new StorageSignedUrlError("invalid");
    }
    const signedMethod = single(PARAMS.method) ?? "GET";
    if (signedMethod !== "GET" && signedMethod !== "PUT") {
      throw new StorageSignedUrlError("invalid");
    }
    const lengthText = single(PARAMS.contentLength);
    if (lengthText !== undefined && !/^\d{1,15}$/.test(lengthText)) {
      throw new StorageSignedUrlError("invalid");
    }

    const expires = Number(expiresText);
    const claims: StorageSignedUrlClaims = {
      key,
      method: signedMethod,
      expiresAt: new Date(expires * 1000),
      ...definedOnly({
        contentType: single(PARAMS.contentType),
        contentLength: lengthText !== undefined ? Number(lengthText) : undefined,
        contentDisposition: single(PARAMS.contentDisposition),
      }),
    };

    const given = Buffer.from(signature, "base64url");
    const authentic = this.keys.some((secret) => {
      const expected = this.mac(secret, claims, expires);
      return timingSafeEqualBytes(given, expected);
    });
    if (!authentic) {
      throw new StorageSignedUrlError("invalid");
    }
    if (now >= expires * 1000) {
      throw new StorageSignedUrlError("expired");
    }
    if (signedMethod !== method) {
      throw new StorageSignedUrlError("method");
    }
    return claims;
  }

  private mac(
    secret: Buffer,
    claims: StorageSignedUrlClaims,
    expires: number,
  ): Buffer {
    const input = JSON.stringify([
      "nestjs-storage-v1",
      this.baseUrl.href,
      claims.method,
      claims.key,
      expires,
      claims.contentType ?? null,
      claims.contentLength ?? null,
      claims.contentDisposition ?? null,
    ]);
    return Buffer.from(
      new Bun.CryptoHasher("sha256", secret).update(input).digest(),
    );
  }
}
