import { UnreadableRecordError } from "../errors/unreadable-record.error";
import type { IdempotencyEncryptionOptions } from "../interfaces/idempotency-module-options.interface";
import type {
  IdempotencySealedResponse,
  IdempotencyStoredPayload,
  IdempotencyStoredResponse,
} from "../interfaces/idempotency-store.interface";

const VERSION = "v1";
const IV_BYTES = 12; // 96-bit IV, the GCM recommendation
const AUTH_TAG_BYTES = 16;
const HKDF_INFO = new TextEncoder().encode("nestjs-idempotency:v1");
const EMPTY_SALT = new Uint8Array(0);
const MIN_SECRET_LENGTH = 32;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ResponseCodec {
  seal(
    storeKey: string,
    response: IdempotencyStoredResponse,
  ): IdempotencyStoredPayload | Promise<IdempotencyStoredPayload>;
  open(
    storeKey: string,
    payload: IdempotencyStoredPayload,
  ): IdempotencyStoredResponse | Promise<IdempotencyStoredResponse>;
}

type ValidatedKeyMaterial =
  | { readonly kind: "raw"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "hkdf"; readonly material: Uint8Array<ArrayBuffer> };

interface DerivedKey {
  readonly id: string;
  readonly cryptoKey: CryptoKey;
}

function validateKeyMaterial(
  material: string | Buffer,
  index: number,
): ValidatedKeyMaterial {
  const option = `encryption.keys[${index}]`;
  if (Buffer.isBuffer(material)) {
    if (material.length !== 32) {
      throw new TypeError(
        `IdempotencyModule: \`${option}\` is a Buffer of ${material.length} bytes; it must be 32 bytes.`,
      );
    }
    return { kind: "raw", bytes: new Uint8Array(material) };
  }
  if (typeof material === "string" && material.trim() !== material) {
    throw new TypeError(
      `IdempotencyModule: \`${option}\` starts or ends with whitespace, so it isn't the key ` +
        `you meant. Trim the keys, for example \`split(',').map((key) => key.trim())\`.`,
    );
  }
  if (typeof material === "string" && material.length >= MIN_SECRET_LENGTH) {
    return { kind: "hkdf", material: textEncoder.encode(material) };
  }
  throw new TypeError(
    `IdempotencyModule: \`${option}\` must be 32 random bytes, or a random string of at least ` +
      `${MIN_SECRET_LENGTH} characters (for example \`openssl rand -base64 32\`), not a password.`,
  );
}

async function deriveCryptoKey(
  input: ValidatedKeyMaterial,
): Promise<DerivedKey> {
  let rawKey: Uint8Array<ArrayBuffer>;
  if (input.kind === "raw") {
    rawKey = input.bytes;
  } else {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      input.material,
      "HKDF",
      false,
      ["deriveBits"],
    );
    const derived = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: EMPTY_SALT,
        info: HKDF_INFO,
      },
      baseKey,
      256,
    );
    rawKey = new Uint8Array(derived);
  }

  // The key id only lets rotation pick the right key; it reveals nothing
  // useful about the key (truncated hash of it).
  const digest = new Bun.CryptoHasher("sha256").update(rawKey).digest();
  const id = toBase64Url(digest).slice(0, 8);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return { id, cryptoKey };
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("base64url");
}

/**
 * Seals `IdempotencyStoredResponse`s with AES-256-GCM (WebCrypto `crypto.subtle`).
 * The store key is bound in as additional authenticated data, so a record copied to
 * another key (another user's scope, say) fails authentication instead of replaying there.
 */
export class ResponseCipher implements ResponseCodec {
  private readonly materials: readonly ValidatedKeyMaterial[];
  private keysPromise?: Promise<readonly DerivedKey[]>;

  constructor(options: IdempotencyEncryptionOptions) {
    const list = options?.keys;
    if (!Array.isArray(list) || list.length === 0) {
      throw new TypeError(
        "IdempotencyModule: `encryption.keys` must list at least one key (newest first).",
      );
    }
    this.materials = list.map(validateKeyMaterial);
  }

  private getKeys(): Promise<readonly DerivedKey[]> {
    if (!this.keysPromise) {
      this.keysPromise = Promise.all(this.materials.map(deriveCryptoKey));
    }
    return this.keysPromise;
  }

  async seal(
    storeKey: string,
    response: IdempotencyStoredResponse,
  ): Promise<IdempotencySealedResponse> {
    const keys = await this.getKeys();
    const primary = keys[0]!;
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: textEncoder.encode(storeKey),
          tagLength: AUTH_TAG_BYTES * 8,
        },
        primary.cryptoKey,
        textEncoder.encode(JSON.stringify(response)),
      ),
    );
    const ciphertext = encrypted.subarray(
      0,
      encrypted.byteLength - AUTH_TAG_BYTES,
    );
    const tag = encrypted.subarray(encrypted.byteLength - AUTH_TAG_BYTES);
    return {
      sealed: [
        VERSION,
        primary.id,
        toBase64Url(iv),
        toBase64Url(ciphertext),
        toBase64Url(tag),
      ].join("."),
    };
  }

  async open(
    storeKey: string,
    payload: IdempotencyStoredPayload,
  ): Promise<IdempotencyStoredResponse> {
    if (!("sealed" in payload) || typeof payload.sealed !== "string") {
      // Accepting plaintext would let anyone with store write access plant
      // arbitrary responses, defeating the authentication.
      throw new UnreadableRecordError("record is not sealed");
    }
    const [version, id, iv, ciphertext, tag, ...rest] =
      payload.sealed.split(".");
    if (
      version !== VERSION ||
      rest.length > 0 ||
      !id ||
      !iv ||
      ciphertext === undefined ||
      !tag
    ) {
      throw new UnreadableRecordError("malformed envelope");
    }
    const keys = await this.getKeys();
    const entry = keys.find((k) => k.id === id);
    if (!entry) {
      throw new UnreadableRecordError(`unknown key id "${id}"`);
    }
    try {
      const ivBytes = Buffer.from(iv, "base64url");
      const ctBytes = Buffer.from(ciphertext, "base64url");
      const tagBytes = Buffer.from(tag, "base64url");
      if (
        ivBytes.byteLength !== IV_BYTES ||
        tagBytes.byteLength !== AUTH_TAG_BYTES
      ) {
        throw new Error("Invalid IV or auth tag length");
      }
      const combined = new Uint8Array(ctBytes.byteLength + tagBytes.byteLength);
      combined.set(ctBytes, 0);
      combined.set(tagBytes, ctBytes.byteLength);
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ivBytes,
          additionalData: textEncoder.encode(storeKey),
          tagLength: AUTH_TAG_BYTES * 8,
        },
        entry.cryptoKey,
        combined,
      );
      return JSON.parse(
        textDecoder.decode(plaintext),
      ) as IdempotencyStoredResponse;
    } catch {
      throw new UnreadableRecordError("authentication failed");
    }
  }
}

/** Pass-through used when encryption is off. Rejects sealed records. */
export const plaintextCodec: ResponseCodec = {
  seal: (_key, response) => response,
  open(_key, payload) {
    if ("sealed" in payload) {
      throw new UnreadableRecordError(
        "record is sealed but encryption is not configured",
      );
    }
    return payload;
  },
};
