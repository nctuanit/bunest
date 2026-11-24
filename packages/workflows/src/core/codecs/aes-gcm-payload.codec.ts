import type {
  PayloadCodec,
  PayloadContext,
} from "../interfaces/payload-codec.interface";
import {
  describePlace,
  otherPlaces,
  WORKFLOW_PLACES,
} from "../utils/payload-place.util";

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = SALT_BYTES + IV_BYTES;
/** The first byte of every plaintext: its format. Bit 0: deflated. */
const DEFLATED = 1;
const HKDF_INFO = new TextEncoder().encode("nestjs-workflows payload");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * What `AesGcmPayloadCodec` takes.
 *
 * ```ts
 * const options: AesGcmPayloadCodecOptions = { keys: { '2026-09': process.env.PAYLOADS_KEY! }, current: '2026-09' };
 * ```
 */
export interface AesGcmPayloadCodecOptions {
  /**
   * The keys by id (letters, digits, `_` and `-`): 32 random bytes each (AES-256), as a `Buffer` or `Uint8Array`,
   * or as base64 (`openssl rand -base64 32`). Keep a key here while payloads it encrypted may still be read.
   */
  keys: Record<string, string | Uint8Array>;
  /** The id of the key that encrypts. The others only decrypt: to rotate, add a key and make it `current`. */
  current: string;
  /** Deflate a payload of at least this many bytes (as JSON) before encrypting it; `false` never. Default 1024. */
  compress?: number | false;
}

/**
 * Encrypts payloads with AES-256-GCM (WebCrypto `crypto.subtle`), under a key derived for each payload from the configured one
 * (HKDF-SHA256 with a random salt) and a random IV, so no key nears the 2^32 encryptions random IVs allow, and with
 * the payload's context as additional authenticated data, so a payload that was changed, or moved to another place
 * (another instance, journal entry, job or field), fails to decrypt instead of being read. The key's id is stored with
 * each payload, so rotating keys needs no migration: payloads are decrypted with the key that encrypted them, and
 * written with the current one. Payloads of 1 KiB or more are deflated first. Its `id` is `'aes-256-gcm'`.
 *
 * ```ts
 * WorkflowsModule.forRoot({
 *   codec: new AesGcmPayloadCodec({ keys: { '2026-09': process.env.WORKFLOWS_KEY! }, current: '2026-09' }),
 * })
 * ```
 */
export class AesGcmPayloadCodec implements PayloadCodec {
  readonly id = "aes-256-gcm";
  private readonly keys = new Map<string, Uint8Array<ArrayBuffer>>();
  private readonly hkdfKeys = new Map<string, Promise<CryptoKey>>();
  private readonly current: string;
  private readonly threshold: number;

  constructor(options: AesGcmPayloadCodecOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      options.keys === null ||
      typeof options.keys !== "object"
    ) {
      throw new TypeError(
        "AesGcmPayloadCodec: pass { keys: { [keyId]: key }, current: keyId }.",
      );
    }
    for (const [id, key] of Object.entries(options.keys)) {
      if (!/^[\w-]+$/.test(id)) {
        throw new TypeError(
          `AesGcmPayloadCodec: invalid key id ${JSON.stringify(id)}. Use letters, digits, "_" and "-".`,
        );
      }
      this.keys.set(id, keyBytes(id, key));
    }
    if (!this.keys.has(options.current)) {
      throw new TypeError(
        `AesGcmPayloadCodec: current (${JSON.stringify(options.current)}) must be one of the keys' ids (${[...this.keys.keys()].join(", ") || "none"}).`,
      );
    }
    this.current = options.current;
    const compress = options.compress ?? 1_024;
    if (
      compress !== false &&
      (!Number.isSafeInteger(compress) || compress < 0)
    ) {
      throw new TypeError(
        `AesGcmPayloadCodec: compress (${JSON.stringify(compress)}) must be a number of bytes, or false.`,
      );
    }
    this.threshold = compress === false ? Infinity : compress;
  }

  private getHkdfKey(id: string): Promise<CryptoKey> {
    let cached = this.hkdfKeys.get(id);
    if (!cached) {
      const raw = this.keys.get(id)!;
      cached = crypto.subtle.importKey("raw", raw, "HKDF", false, [
        "deriveKey",
      ]);
      this.hkdfKeys.set(id, cached);
    }
    return cached;
  }

  async encode(value: unknown, context: PayloadContext): Promise<string> {
    const json = textEncoder.encode(JSON.stringify(value));
    const deflated = json.byteLength >= this.threshold;
    const body = deflated ? Bun.deflateSync(json) : json;
    const plaintext = new Uint8Array(1 + body.byteLength);
    plaintext[0] = deflated ? DEFLATED : 0;
    plaintext.set(body, 1);

    const header = crypto.getRandomValues(new Uint8Array(HEADER_BYTES));
    const payloadKey = await derivePayloadKey(
      await this.getHkdfKey(this.current),
      header.subarray(0, SALT_BYTES),
      "encrypt",
    );
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: header.subarray(SALT_BYTES),
          additionalData: associated(this.current, context),
          tagLength: TAG_BYTES * 8,
        },
        payloadKey,
        plaintext,
      ),
    );
    const out = new Uint8Array(header.byteLength + encrypted.byteLength);
    out.set(header, 0);
    out.set(encrypted, header.byteLength);
    return `${this.current}.${Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString("base64url")}`;
  }

  async decode(data: string, context: PayloadContext): Promise<unknown> {
    const dot = data.indexOf(".");
    const id = data.slice(0, dot);
    if (dot < 0 || !this.keys.has(id)) {
      throw new Error(
        `AesGcmPayloadCodec: a payload of ${describePlace(context)} was encrypted with key ${JSON.stringify(id)}, which isn't in keys. ` +
          "Keep a key in keys while payloads it encrypted may still be read.",
      );
    }
    const bytes = new Uint8Array(Buffer.from(data.slice(dot + 1), "base64url"));
    let plaintext: Uint8Array;
    try {
      if (bytes.byteLength < HEADER_BYTES + TAG_BYTES) {
        throw new Error("Payload too short");
      }
      const payloadKey = await derivePayloadKey(
        await this.getHkdfKey(id),
        bytes.subarray(0, SALT_BYTES),
        "decrypt",
      );
      const decrypted = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.subarray(SALT_BYTES, HEADER_BYTES),
          additionalData: associated(id, context),
          tagLength: TAG_BYTES * 8,
        },
        payloadKey,
        bytes.subarray(HEADER_BYTES),
      );
      plaintext = new Uint8Array(decrypted);
    } catch {
      throw new Error(
        `AesGcmPayloadCodec: a payload of ${describePlace(context)} failed authentication: it was changed, or encrypted for another place.`,
      );
    }
    const body = plaintext.subarray(1);
    const rawJson =
      ((plaintext[0] ?? 0) & DEFLATED) === DEFLATED
        ? Bun.inflateSync(new Uint8Array(body))
        : body;
    return JSON.parse(textDecoder.decode(rawJson));
  }
}

function keyBytes(id: string, key: unknown): Uint8Array<ArrayBuffer> {
  const advice =
    "Give it 32 random bytes, as a Buffer, a Uint8Array, or base64 (`openssl rand -base64 32`).";
  let bytes: Uint8Array<ArrayBuffer>;
  if (key instanceof Uint8Array) {
    bytes = new Uint8Array(key);
  } else if (typeof key === "string") {
    // Buffer.from() skips what isn't base64, so a key with a typo would decode to other bytes instead of failing.
    const text = key.trim();
    if (text.length === 0) {
      throw new TypeError(
        `AesGcmPayloadCodec: key "${id}" is an empty string. ${advice}`,
      );
    }
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
      throw new TypeError(
        `AesGcmPayloadCodec: key "${id}" isn't base64. ${advice}`,
      );
    }
    bytes = new Uint8Array(Buffer.from(text, "base64"));
  } else {
    const what =
      key === undefined
        ? "undefined (an environment variable that isn't set?)"
        : key === null
          ? "null"
          : typeof key === "object"
            ? "an object"
            : `a ${typeof key}`;
    throw new TypeError(
      `AesGcmPayloadCodec: key "${id}" is ${what}. ${advice}`,
    );
  }
  if (bytes.byteLength !== 32) {
    throw new TypeError(
      `AesGcmPayloadCodec: key "${id}" is ${bytes.byteLength} bytes; AES-256 takes 32 (as a Buffer, or base64: \`openssl rand -base64 32\`).`,
    );
  }
  return bytes;
}

/** The payload's own key: HKDF-SHA256 of the configured key, with the salt that starts the payload's bytes. */
async function derivePayloadKey(
  hkdfKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: HKDF_INFO,
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/**
 * The additional authenticated data: the key's id, then the context: its `field` and workflows' places (`null` where
 * absent) first, in the order this codec was built with, so what it encrypted then still decrypts, then any other
 * key, by name, with its value.
 */
function associated(
  key: string,
  context: PayloadContext,
): Uint8Array<ArrayBuffer> {
  const places = WORKFLOW_PLACES.map((place) => context[place] ?? null);
  const others = otherPlaces(context).flatMap((place) => [
    place,
    context[place],
  ]);
  return textEncoder.encode(
    JSON.stringify([key, context.field, ...places, ...others]),
  );
}
