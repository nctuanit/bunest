import { Inject, Injectable, Optional } from "@bunest/core";

export const PASSWORD_OPTIONS = Symbol.for("bunest:security:password_options");

export interface PasswordHashOptions {
  algorithm?: "argon2id" | "argon2d" | "argon2i" | "bcrypt";
  memoryCost?: number;
  timeCost?: number;
  cost?: number;
}

/**
 * Native Bun password hashing service (`Bun.password`) defaulting to argon2id.
 */
@Injectable()
export class PasswordService {
  constructor(
    @Optional()
    @Inject(PASSWORD_OPTIONS)
    private readonly defaultOptions: PasswordHashOptions = {},
  ) {}

  async hash(
    password: string,
    overrideOptions?: PasswordHashOptions,
  ): Promise<string> {
    const merged = { ...this.defaultOptions, ...overrideOptions };
    const algorithm = merged.algorithm ?? "argon2id";

    if (algorithm === "bcrypt") {
      return Bun.password.hash(password, {
        algorithm: "bcrypt",
        cost: merged.cost ?? 10,
      });
    }

    return Bun.password.hash(password, {
      algorithm,
      memoryCost: merged.memoryCost ?? 65536,
      timeCost: merged.timeCost ?? 2,
    });
  }

  async verify(password: string, hashed: string): Promise<boolean> {
    if (typeof password !== "string" || typeof hashed !== "string" || !hashed) {
      return false;
    }
    try {
      return await Bun.password.verify(password, hashed);
    } catch {
      return false;
    }
  }
}
