import type { PasswordHasherOptions } from "../interfaces/password-hasher-options.interface";
import { randomBytes, timingSafeEqualBytes } from "../utils/crypto.util";
import { scryptAsync } from "../utils/scrypt.util";

const FORMAT =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{16,})\$([A-Za-z0-9+/]{16,})$/;
const MAX_PASSWORD_BYTES = 4096;

interface ScryptParams {
  logN: number;
  r: number;
  p: number;
}

function scrypt(
  password: Buffer,
  salt: Buffer,
  keyLength: number,
  { logN, r, p }: ScryptParams,
): Promise<Buffer> {
  return scryptAsync(password, salt, keyLength, { N: 2 ** logN, r, p });
}

const b64 = (buf: Buffer): string => buf.toString("base64").replace(/=+$/, "");
const work = ({ logN, r, p }: ScryptParams): number => 2 ** logN * r * p;

/**
 * @internal The bytes `PasswordHasher` derives from: NFKC-normalised UTF-8.
 */
export function encodePassword(password: unknown): Buffer {
  if (typeof password !== "string") {
    throw new TypeError("password must be a string");
  }
  if (password.length > MAX_PASSWORD_BYTES) {
    throw new RangeError("password too long");
  }
  const input = Buffer.from(password.normalize("NFKC"), "utf8");
  if (input.length === 0) {
    throw new RangeError("password is empty");
  }
  if (input.length > MAX_PASSWORD_BYTES) {
    throw new RangeError("password too long");
  }
  return input;
}

/** @internal Whether `PasswordHasher.hash()` takes `password`. */
export function isHashablePassword(password: unknown): password is string {
  try {
    encodePassword(password);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unified password hashing powered by Bun's native `Bun.password` (`argon2id` default,
 * plus `argon2d`/`argon2i`/`bcrypt`) with full backward-compatible `$scrypt$` verification,
 * NFKC normalization, dummy-hash timing equalization, and cost-upgrade `needsRehash()`.
 */
export class PasswordHasher {
  private readonly algorithm:
    | "argon2id"
    | "argon2d"
    | "argon2i"
    | "bcrypt"
    | "scrypt";
  private readonly memoryCost: number;
  private readonly timeCost: number;
  private readonly bcryptCost: number;
  private readonly params: ScryptParams;
  private readonly keyLength: number;
  private readonly saltLength: number;
  private dummy?: Promise<string>;

  constructor(options: PasswordHasherOptions = {}) {
    const hasExplicitScryptParams =
      options.logN !== undefined ||
      options.r !== undefined ||
      options.p !== undefined ||
      options.keyLength !== undefined ||
      options.saltLength !== undefined;
    this.algorithm =
      options.algorithm ?? (hasExplicitScryptParams ? "scrypt" : "argon2id");
    this.memoryCost = options.memoryCost ?? 65536;
    this.timeCost = options.timeCost ?? 2;
    this.bcryptCost = options.cost ?? 10;
    this.params = {
      logN: options.logN ?? 17,
      r: options.r ?? 8,
      p: options.p ?? 1,
    };
    this.keyLength = options.keyLength ?? 32;
    this.saltLength = options.saltLength ?? 16;
    if (!isSane(this.params)) {
      throw new RangeError("PasswordHasher: unsupported scrypt parameters");
    }
    for (const [name, value] of [
      ["keyLength", this.keyLength],
      ["saltLength", this.saltLength],
    ] as const) {
      if (!Number.isInteger(value) || value < 16 || value > 64) {
        throw new RangeError(
          `PasswordHasher: \`${name}\` must be an integer from 16 to 64 bytes, got ${String(value)}`,
        );
      }
    }
  }

  async hash(password: string): Promise<string> {
    const input = this.encodeInput(password);
    if (this.algorithm === "scrypt") {
      const salt = randomBytes(this.saltLength);
      const key = await this.derive(input, salt, this.keyLength, this.params);
      const { logN, r, p } = this.params;
      return `$scrypt$ln=${logN},r=${r},p=${p}$${b64(salt)}$${b64(key)}`;
    }
    const normalized = input.toString("utf8");
    if (this.algorithm === "bcrypt") {
      return await Bun.password.hash(normalized, {
        algorithm: "bcrypt",
        cost: this.bcryptCost,
      });
    }
    return await Bun.password.hash(normalized, {
      algorithm: this.algorithm,
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
    });
  }

  async verify(
    password: string,
    encoded: string | null | undefined,
  ): Promise<boolean> {
    if (!encoded) {
      if (!this.dummy) {
        this.dummy = this.hash("dummy password for timing equalisation").catch(
          (error) => {
            this.dummy = undefined;
            throw error;
          },
        );
        await this.dummy;
      } else {
        await this.verify(password, await this.dummy);
      }
      return false;
    }

    let input: Buffer;
    try {
      input = this.encodeInput(password);
    } catch {
      return false;
    }

    // Native Bun.password PHC formats ($argon2id$, $argon2d$, $argon2i$, $2a$/$2b$/$2y$)
    if (isBunPasswordHash(encoded)) {
      try {
        return await Bun.password.verify(input.toString("utf8"), encoded);
      } catch {
        return false;
      }
    }

    const parsed = parse(encoded);
    if (!parsed) {
      return this.verify(password, undefined);
    }
    const actual = await this.derive(
      input,
      parsed.salt,
      parsed.hash.length,
      parsed.params,
    );
    if (this.algorithm === "scrypt") {
      let missing = work(this.params) - work(parsed.params);
      for (let logN = this.params.logN - 1; logN >= 1 && missing > 0; logN--) {
        const params: ScryptParams = { ...this.params, logN };
        if (work(params) <= missing) {
          await this.derive(input, parsed.salt, this.keyLength, params);
          missing -= work(params);
        }
      }
    }
    return timingSafeEqualBytes(actual, parsed.hash);
  }

  needsRehash(encoded: string): boolean {
    if (this.algorithm === "scrypt") {
      const parsed = parse(encoded);
      if (!parsed) {
        return true;
      }
      const { logN, r, p } = parsed.params;
      return (
        logN !== this.params.logN ||
        r !== this.params.r ||
        p !== this.params.p ||
        parsed.hash.length !== this.keyLength ||
        parsed.salt.length < this.saltLength
      );
    }
    if (this.algorithm === "bcrypt") {
      const match = /^\$2[aby]\$(\d{2})\$/.exec(encoded);
      return !match || Number(match[1]) !== this.bcryptCost;
    }
    const match = /^\$(argon2id|argon2d|argon2i)\$v=\d+\$m=(\d+),t=(\d+),p=\d+\$/.exec(
      encoded,
    );
    if (!match) {
      return true;
    }
    return (
      match[1] !== this.algorithm ||
      Number(match[2]) !== this.memoryCost ||
      Number(match[3]) !== this.timeCost
    );
  }

  private derive(
    input: Buffer,
    salt: Buffer,
    keyLength: number,
    params: ScryptParams,
  ): Promise<Buffer> {
    return scrypt(input, salt, keyLength, params);
  }

  private encodeInput(password: string): Buffer {
    return encodePassword(password);
  }
}

function isBunPasswordHash(encoded: string): boolean {
  return (
    encoded.startsWith("$argon2id$") ||
    encoded.startsWith("$argon2d$") ||
    encoded.startsWith("$argon2i$") ||
    /^\$2[aby]\$\d{2}\$/.test(encoded)
  );
}

function isSane({ logN, r, p }: ScryptParams): boolean {
  return (
    [logN, r, p].every(Number.isInteger) &&
    logN >= 10 &&
    logN <= 22 &&
    r >= 1 &&
    r <= 32 &&
    p >= 1 &&
    p <= 16 &&
    2 ** logN * r <= 2 ** 23 &&
    2 ** logN * r * p <= 2 ** 24
  );
}

function parse(
  encoded: string,
): { params: ScryptParams; salt: Buffer; hash: Buffer } | undefined {
  const match = FORMAT.exec(encoded);
  if (!match) {
    return undefined;
  }
  const params: ScryptParams = {
    logN: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
  };
  if (!isSane(params)) {
    return undefined;
  }
  const salt = Buffer.from(match[4]!, "base64");
  const hash = Buffer.from(match[5]!, "base64");
  if (hash.length < 16 || hash.length > 64 || salt.length > 64) {
    return undefined;
  }
  return { params, salt, hash };
}
