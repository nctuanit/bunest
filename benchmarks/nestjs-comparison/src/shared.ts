import { IsEmail, IsInt, IsString, Min, MinLength } from "class-validator";

export interface BenchUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly age: number;
}

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly age: number;
}

export const SEED_USERS = new Map<string, BenchUser>();
for (let i = 1; i <= 100; i += 1) {
  SEED_USERS.set(String(i), {
    id: String(i),
    email: `user${i}@bunest.dev`,
    name: `User ${i}`,
    age: 20 + (i % 30),
  });
}

export const VALID_POST_PAYLOAD: CreateUserInput = {
  email: "alice@bunest.dev",
  name: "Alice Nguyen",
  age: 28,
};

/** Exact 59-byte JSON payload matching benchmarks/http-benchmark.ts */
export const VALID_POST_PAYLOAD_JSON = JSON.stringify(VALID_POST_PAYLOAD);

export const INVALID_POST_PAYLOAD_JSON = JSON.stringify({
  email: "not-an-email",
  name: "Al",
  age: 12,
});

export const EXTRA_FIELD_POST_PAYLOAD_JSON = JSON.stringify({
  email: "alice@bunest.dev",
  name: "Alice Nguyen",
  age: 28,
  injectedAdmin: true,
});

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(3)
  name!: string;

  @IsInt()
  @Min(18)
  age!: number;
}

export function findUserById(id: string): BenchUser {
  return (
    SEED_USERS.get(id) ?? {
      id,
      email: `unknown-${id}@bunest.dev`,
      name: "Unknown",
      age: 25,
    }
  );
}

export function createUserRecord(payload: CreateUserInput): BenchUser {
  return {
    id: "u_new",
    email: payload.email,
    name: payload.name,
    age: payload.age,
  };
}
