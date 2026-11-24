import type { WebhookEncryptionOptions } from "../interfaces/webhooks-module-options.interface";

export interface SecretCodec {
  seal(endpointId: string, secret: string): string | Promise<string>;
  open(endpointId: string, stored: string): string | Promise<string>;
}

const PREFIX = "sealed.v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HKDF_INFO = new TextEncoder().encode("nestjs-webhooks:v1");
const EMPTY_SALT = new Uint8Array(0);
const MIN_SECRET_LENGTH = 32;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const plaintextSecrets: SecretCodec = {
  seal: (_endpointId, secret) => secret,
  open(_endpointId, stored) {
    if (stored.startsWith(`${PREFIX}.`)) {
      throw new Error(
        "This endpoint secret is encrypted, and WebhooksModule has no `encryption` keys to open it",
      );
    }
    return stored;
  },
};

type ValidatedKeyMaterial =
  | { readonly kind: "raw"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "hkdf"; readonly material: Uint8Array<ArrayBuffer> };

interface DerivedKey {
  readonly id: string;
  readonly cryptoKey: CryptoKey;
}

/**
 * AES-256-GCM (WebCrypto `crypto.subtle`) with the endpoint id as additional data, so a sealed
 * secret copied to another endpoint's row fails to open instead of signing there. The first key
 * seals, every key opens (rotation); key ids are a truncated SHA-256 hash of the key. A plaintext
 * secret still opens (endpoints created before encryption was turned on) and is sealed at its next
 * rotation.
 */
export class SecretCipher implements SecretCodec {
  private readonly materials: readonly ValidatedKeyMaterial[];
  private keysPromise?: Promise<readonly DerivedKey[]>;

  constructor(options: WebhookEncryptionOptions) {
    const list = options?.keys;
    if (!Array.isArray(list) || list.length === 0) {
      throw new TypeError(
        "WebhooksModule: `encryption.keys` must list at least one key (newest first).",
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

  async seal(endpointId: string, secret: string): Promise<string> {
    const keys = await this.getKeys();
    const { id, cryptoKey } = keys[0]!;
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: textEncoder.encode(endpointId),
          tagLength: AUTH_TAG_BYTES * 8,
        },
        cryptoKey,
        textEncoder.encode(secret),
      ),
    );
    const ciphertext = encrypted.subarray(
      0,
      encrypted.byteLength - AUTH_TAG_BYTES,
    );
    const tag = encrypted.subarray(encrypted.byteLength - AUTH_TAG_BYTES);
    return [
      PREFIX,
      id,
      toBase64Url(iv),
      toBase64Url(ciphertext),
      toBase64Url(tag),
    ].join(".");
  }

  async open(endpointId: string, stored: string): Promise<string> {
    if (!stored.startsWith(`${PREFIX}.`)) {
      return stored;
    }
    const [, , id, iv, ciphertext, tag, ...rest] = stored.split(".");
    if (rest.length > 0 || !tag || !iv || !ciphertext || !id) {
      throw new Error("Malformed sealed endpoint secret");
    }
    const keys = await this.getKeys();
    const entry = keys.find((key) => key.id === id);
    if (!entry) {
      throw new Error(
        `Endpoint secret sealed with an unknown key (id "${id}"): add that key to encryption.keys`,
      );
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
          additionalData: textEncoder.encode(endpointId),
          tagLength: AUTH_TAG_BYTES * 8,
        },
        entry.cryptoKey,
        combined,
      );
      return textDecoder.decode(plaintext);
    } catch {
      throw new Error(
        `Endpoint secret of ${endpointId} failed authentication (tampered, or sealed for another endpoint)`,
      );
    }
  }
}

function validateKeyMaterial(
  material: string | Buffer,
  index: number,
): ValidatedKeyMaterial {
  const option = `encryption.keys[${index}]`;
  if (Buffer.isBuffer(material)) {
    if (material.length !== 32) {
      throw new TypeError(
        `WebhooksModule: \`${option}\` is a Buffer of ${material.length} bytes; it must be 32 bytes.`,
      );
    }
    return { kind: "raw", bytes: new Uint8Array(material) };
  }
  if (typeof material === "string" && material.trim() !== material) {
    throw new TypeError(
      `WebhooksModule: \`${option}\` starts or ends with whitespace, so it isn't the key you meant. ` +
        "Trim the keys, for example `split(',').map((key) => key.trim())`.",
    );
  }
  if (typeof material === "string" && material.length >= MIN_SECRET_LENGTH) {
    return { kind: "hkdf", material: textEncoder.encode(material) };
  }
  throw new TypeError(
    `WebhooksModule: \`${option}\` must be 32 random bytes, or a random string of at least ${MIN_SECRET_LENGTH} ` +
      "characters (for example `openssl rand -base64 32`), not a password.",
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
