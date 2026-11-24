/**
 * Password hashing parameters.
 *
 * Defaults to Bun's native `Bun.password` (`argon2id`) when no explicit scrypt
 * parameters (`logN`/`r`/`p`) are provided. Legacy `$scrypt$` hashes are always
 * verified transparently and flagged by `needsRehash()` for seamless upgrade.
 */
export interface PasswordHasherOptions {
  /** Hashing algorithm. Defaults to `"argon2id"` (or `"scrypt"` if `logN`/`r`/`p` are passed). */
  algorithm?: "argon2id" | "argon2d" | "argon2i" | "bcrypt" | "scrypt";
  /** Argon2 memory cost in KiB (Bun.password default: 65536). */
  memoryCost?: number;
  /** Argon2 time cost / iterations (Bun.password default: 2). */
  timeCost?: number;
  /** Bcrypt cost factor (4–31, default: 10). */
  cost?: number;
  /** log2 of the scrypt cost N, an integer from 10 to 22. Default 17 (scrypt mode). */
  logN?: number;
  /** Block size, 1 to 32. Default 8 (scrypt mode). */
  r?: number;
  /** Parallelism, 1 to 16. Default 1 (scrypt mode). */
  p?: number;
  /** Derived key length, 16 to 64 bytes. Default 32 (scrypt mode). */
  keyLength?: number;
  /** Salt length, 16 to 64 bytes. Default 16 (scrypt mode). */
  saltLength?: number;
}
