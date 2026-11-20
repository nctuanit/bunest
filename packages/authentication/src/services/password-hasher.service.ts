import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import type { PasswordHasherOptions } from "../interfaces/password-hasher-options.interface";

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
  const N = 2 ** logN;
  const options = { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
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
 * scrypt password hashing with PHC self-describing format (`$scrypt$ln=17,r=8,p=1$salt$hash`),
 * NFKC normalization, dummy-hash timing equalization, and cost-upgrade work top-up.
 */
export class PasswordHasher {
  private readonly params: ScryptParams;
  private readonly keyLength: number;
  private readonly saltLength: number;
  private dummy?: Promise<string>;

  constructor(options: PasswordHasherOptions = {}) {
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
    const salt = randomBytes(this.saltLength);
    const key = await this.derive(input, salt, this.keyLength, this.params);
    const { logN, r, p } = this.params;
    return `$scrypt$ln=${logN},r=${r},p=${p}$${b64(salt)}$${b64(key)}`;
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
    const parsed = parse(encoded);
    if (!parsed) {
      return this.verify(password, undefined);
    }
    let input: Buffer;
    try {
      input = this.encodeInput(password);
    } catch {
      return false;
    }
    const actual = await this.derive(
      input,
      parsed.salt,
      parsed.hash.length,
      parsed.params,
    );
    let missing = work(this.params) - work(parsed.params);
    for (let logN = this.params.logN - 1; logN >= 1 && missing > 0; logN--) {
      const params: ScryptParams = { ...this.params, logN };
      if (work(params) <= missing) {
        await this.derive(input, parsed.salt, this.keyLength, params);
        missing -= work(params);
      }
    }
    return timingSafeEqual(actual, parsed.hash);
  }

  needsRehash(encoded: string): boolean {
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
