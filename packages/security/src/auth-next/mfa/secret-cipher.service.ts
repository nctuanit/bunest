import { SecretDecryptionError } from "../errors/secret-decryption.error";
import type { SecretEncryptionOptions } from "../interfaces/mfa-options.interface";
import { requireOption } from "../utils/options.util";

const VERSION = "v1";
const HKDF_INFO = Buffer.from("nestjs-authentication totp-secret v1", "utf8");
const MIN_SECRET_LENGTH = 32;
const OPTION = "mfa.encryption.keys";

interface KeyEntry {
  id: string;
  raw: Uint8Array<ArrayBuffer>;
  cryptoKey?: Promise<CryptoKey>;
}

/**
 * AES-256-GCM via WebCrypto (`crypto.subtle`) for secrets the server must read back
 * (TOTP seeds cannot be hashed). Format: `v1.<keyId>.<iv>.<ciphertext>.<tag>`, base64url parts.
 */
export class SecretCipher {
  private readonly options: SecretEncryptionOptions;
  private readonly keys = new Map<string, KeyEntry>();
  private readonly currentId: string;

  constructor(options: SecretEncryptionOptions) {
    this.options = options;
    const list = options?.keys;
    if (!Array.isArray(list) || list.length === 0) {
      throw new TypeError(
        `MFA: \`${OPTION}\` must list at least one key (newest first).`,
      );
    }
    const derived = list.map(deriveKey);
    for (const entry of derived) {
      if (!this.keys.has(entry.id)) {
        this.keys.set(entry.id, entry);
      }
    }
    this.currentId = derived[0]!.id;
  }

  async encrypt(plaintext: string, context: string): Promise<string> {
    const entry = this.keys.get(this.currentId)!;
    const key = await this.getCryptoKey(entry);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const data = toArrayBufferUint8Array(Buffer.from(plaintext, "utf8"));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad(this.currentId, context),
          tagLength: 128,
        },
        key,
        data,
      ),
    );
    const ciphertext = encrypted.subarray(0, encrypted.byteLength - 16);
    const tag = encrypted.subarray(encrypted.byteLength - 16);
    return [
      VERSION,
      this.currentId,
      toBase64Url(iv),
      toBase64Url(ciphertext),
      toBase64Url(tag),
    ].join(".");
  }

  async decrypt(
    stored: string,
    context: string,
  ): Promise<{ plaintext: string; needsReencrypt: boolean }> {
    if (!stored.startsWith(`${VERSION}.`)) {
      if (this.options.migratePlaintext) {
        return { plaintext: stored, needsReencrypt: true };
      }
      throw new SecretDecryptionError("value is not encrypted");
    }
    const parts = stored.split(".");
    if (parts.length !== 5) {
      throw new SecretDecryptionError("malformed ciphertext");
    }
    const keyId = parts[1]!;
    const iv = toArrayBufferUint8Array(Buffer.from(parts[2]!, "base64url"));
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    const tag = Buffer.from(parts[4]!, "base64url");
    const entry = this.keys.get(keyId);
    if (!entry) {
      throw new SecretDecryptionError(`unknown key id '${keyId}'`);
    }
    if (iv.byteLength !== 12 || tag.byteLength !== 16) {
      throw new SecretDecryptionError("malformed ciphertext");
    }
    const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.byteLength);
    try {
      const key = await this.getCryptoKey(entry);
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad(keyId, context),
          tagLength: 128,
        },
        key,
        combined,
      );
      return {
        plaintext: Buffer.from(plain).toString("utf8"),
        needsReencrypt: keyId !== this.currentId,
      };
    } catch {
      throw new SecretDecryptionError("authentication failed");
    }
  }

  needsReencrypt(stored: string): boolean {
    return !stored.startsWith(`${VERSION}.${this.currentId}.`);
  }

  private getCryptoKey(entry: KeyEntry): Promise<CryptoKey> {
    entry.cryptoKey ??= crypto.subtle.importKey(
      "raw",
      entry.raw,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    return entry.cryptoKey;
  }
}

function aad(keyId: string, context: string): Uint8Array<ArrayBuffer> {
  return toArrayBufferUint8Array(
    Buffer.from(`${VERSION}.${keyId}.${context}`, "utf8"),
  );
}

function toArrayBufferUint8Array(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("base64url");
}

/** RFC 5869 HKDF-SHA256 for 32-byte OKM (empty salt => 32 zero-byte salt). */
function hkdfSha256_32(ikm: string, info: Uint8Array): Uint8Array<ArrayBuffer> {
  const prk = new Bun.CryptoHasher("sha256", new Uint8Array(32))
    .update(ikm, "utf8")
    .digest();
  const expandInput = new Uint8Array(info.byteLength + 1);
  expandInput.set(info, 0);
  expandInput[info.byteLength] = 0x01;
  const okm = new Bun.CryptoHasher("sha256", prk)
    .update(expandInput)
    .digest();
  return toArrayBufferUint8Array(okm);
}

function deriveKey(material: string | Uint8Array, index: number): KeyEntry {
  const option = `${OPTION}[${index}]`;
  requireOption(
    material,
    option,
    `32 random bytes, or a random string of at least ${MIN_SECRET_LENGTH} characters`,
  );
  let raw: Uint8Array<ArrayBuffer>;
  if (material instanceof Uint8Array) {
    if (material.byteLength !== 32) {
      throw new TypeError(
        `MFA: \`${option}\` is a Buffer of ${material.byteLength} bytes; it must be 32 bytes.`,
      );
    }
    raw = toArrayBufferUint8Array(material);
  } else if (
    typeof material === "string" &&
    material.length >= MIN_SECRET_LENGTH
  ) {
    raw = hkdfSha256_32(material, HKDF_INFO);
  } else {
    throw new TypeError(
      `MFA: \`${option}\` must be 32 random bytes, or a random string of at least ${MIN_SECRET_LENGTH} ` +
        "characters (for example `openssl rand -base64 32`), not a password.",
    );
  }
  const id = toBase64Url(
    new Bun.CryptoHasher("sha256").update(raw).digest(),
  ).slice(0, 8);
  return { id, raw };
}
