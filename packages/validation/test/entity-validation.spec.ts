import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as CommonPkg from "@bunest/common";
import {
  BODY_SANITIZED_SYMBOL,
  BadRequestException,
  Column,
  CreateDateColumn,
  Entity,
  HttpException,
  HttpStatus,
  PrimaryGeneratedColumn,
  PrimaryKey,
  UnprocessableEntityException,
  UpdateDateColumn,
  type ValidationErrorResponse,
} from "@bunest/common";
import { Transform } from "class-transformer";
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from "class-validator";
import {
  ValidationPipe,
  flattenValidationErrors,
  validateEntity,
} from "../src";

@Entity({ tableName: "users", description: "User account entity" })
class UserEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ minLength: 2, maxLength: 30, pattern: /^[a-zA-Z0-9_]+$/g })
  username!: string;

  @Column({ type: "varchar", length: 50 })
  displayName!: string;

  @Column({ type: "integer", min: 13, max: 120 })
  age!: number;

  @Column({ type: "real", min: 0, max: 5, nullable: true })
  rating?: number | null;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @Column({ enum: ["admin", "member", "guest"], default: "member" })
  role!: string;

  @Column({ type: "uuid", nullable: true })
  externalId?: string | null;

  @Column({ type: "datetime", nullable: true })
  birthDate?: Date | null;

  @Column({ type: "json", nullable: true })
  tags?: string[] | null;

  @Column({ type: "json", nullable: true })
  metadata?: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  // Non-column default class property initializer (must NEVER trigger whitelist failure)
  internalFlag = "ok";

  getLabel(): string {
    return `${this.username} (${this.role})`;
  }
}

@Entity("manual_pk_items")
class ManualPkEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Column({ type: "bigint", min: 1 })
  serial!: bigint;

  @Column({ type: "blob", nullable: true })
  payload?: Uint8Array | null;
}

@Entity("base_records")
class BaseRecordEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity("derived_articles")
class DerivedArticleEntity extends BaseRecordEntity {
  @Column({ minLength: 3, maxLength: 100 })
  title!: string;

  @Column({ enum: [1, 2, 3], type: "integer" })
  priority!: number;
}

@Entity("hybrid_users")
class HybridUserEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ minLength: 2, maxLength: 40 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  name!: string;

  @Column({ unique: true })
  @IsEmail()
  email!: string;

  @Column({ type: "integer", min: 18, max: 120 })
  @IsInt()
  @Min(18, { message: "must be at least 18 years old" })
  age!: number;

  @Column({ minLength: 3 })
  @IsOptional()
  bio?: string;

  @IsOptional()
  @IsString()
  cvOnlyNote?: string;
}

class UndecoratedClass {
  name!: string;
}

async function expectValidationHttpException(
  promise: Promise<unknown>,
): Promise<HttpException> {
  try {
    await promise;
    throw new Error("Expected promise to reject with HttpException");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    return err as HttpException;
  }
}

describe("Entity Schema Single-Source-of-Truth Validation (validateEntity & ValidationPipe)", () => {
  describe("validateEntity() standalone helper", () => {
    it("validates valid create payload, skips generated PK/timestamps/defaults/nullable, coerces safe primitives, and instantiates entity", () => {
      const res = validateEntity(UserEntity, {
        username: "ada_lovelace",
        displayName: "Ada Lovelace",
        age: "28",
        rating: "4.75",
        active: "false",
        externalId: "550e8400-e29b-41d4-a716-446655440000",
        birthDate: "1998-12-10T00:00:00.000Z",
        tags: ["ts", "bun"],
        metadata: { theme: "dark" },
      });

      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
      expect(res.value).toBeInstanceOf(UserEntity);
      expect(res.value.username).toBe("ada_lovelace");
      expect(res.value.age).toBe(28);
      expect(typeof res.value.age).toBe("number");
      expect(res.value.rating).toBe(4.75);
      expect(res.value.active).toBe(false);
      expect(res.value.birthDate).toBeInstanceOf(Date);
      expect(res.value.birthDate?.toISOString()).toBe("1998-12-10T00:00:00.000Z");
      expect(res.value.tags).toEqual(["ts", "bun"]);
      expect(res.value.metadata).toEqual({ theme: "dark" });
      expect(res.value.id).toBeUndefined();
      expect(res.value.internalFlag).toBe("ok");
      expect(res.value.getLabel()).toBe("ada_lovelace (undefined)");

      // Repeated call proves /g pattern RegExp is tested statelessly!
      const second = validateEntity(UserEntity, {
        username: "ada_lovelace",
        displayName: "Ada",
        age: 30,
      });
      expect(second.valid).toBe(true);
    });

    it("enforces all column type & constraint checks (minLength, maxLength/length, pattern, enum, min, max, uuid, datetime, bigint, blob, nullable)", () => {
      const res = validateEntity(UserEntity, {
        id: "not-an-int",
        username: "!",
        displayName: "x".repeat(51),
        age: 10,
        rating: 9.5,
        active: "not-a-bool",
        role: "superroot",
        externalId: "not-a-uuid",
        birthDate: "2026-02-30",
        tags: "not-an-array",
      });

      expect(res.valid).toBe(false);
      const byField = new Map(
        flattenValidationErrors(res.errors).map((d) => [d.field, d]),
      );

      expect(byField.get("id")?.constraints.isInt).toBeDefined();
      expect(byField.get("username")?.constraints.minLength).toBeDefined();
      expect(byField.get("username")?.constraints.matches).toBeDefined();
      expect(byField.get("displayName")?.constraints.maxLength).toBeDefined();
      expect(byField.get("age")?.constraints.min).toBeDefined();
      expect(byField.get("rating")?.constraints.max).toBeDefined();
      expect(byField.get("active")?.constraints.isBoolean).toBeDefined();
      expect(byField.get("role")?.constraints.isEnum).toBeDefined();
      expect(byField.get("externalId")?.constraints.isUuid).toBeDefined();
      expect(byField.get("birthDate")?.constraints.isDate).toBeDefined();
      expect(byField.get("tags")?.constraints.isArray).toBeDefined();

      // Required non-nullable columns fail when omitted or null
      const missingRes = validateEntity(UserEntity, {
        username: null,
        rating: null,
      });
      expect(missingRes.valid).toBe(false);
      const missingFields = new Set(missingRes.errors.map((e) => e.property));
      expect(missingFields.has("username")).toBe(true);
      expect(missingFields.has("displayName")).toBe(true);
      expect(missingFields.has("age")).toBe(true);
      expect(missingFields.has("rating")).toBe(false); // nullable: true allows null
      expect(missingFields.has("id")).toBe(false); // generated PK skipped
      expect(missingFields.has("createdAt")).toBe(false); // createdAt skipped
      expect(missingFields.has("updatedAt")).toBe(false); // updatedAt skipped
      expect(missingFields.has("role")).toBe(false); // hasDefault skipped

      // Non-generated @PrimaryKey, bigint, and blob columns
      const pkFail = validateEntity(ManualPkEntity, {
        serial: "0",
        payload: "not-binary",
      });
      expect(pkFail.valid).toBe(false);
      const pkByField = new Map(
        flattenValidationErrors(pkFail.errors).map((d) => [d.field, d]),
      );
      expect(pkByField.get("id")?.constraints.isDefined).toBeDefined();
      expect(pkByField.get("serial")?.constraints.min).toBeDefined();
      expect(pkByField.get("payload")?.constraints.isBlob).toBeDefined();

      const pkOk = validateEntity(ManualPkEntity, {
        id: "550e8400-e29b-41d4-a716-446655440000",
        serial: "9007199254740993",
        payload: new Uint8Array([1, 2, 3]),
      });
      expect(pkOk.valid).toBe(true);
      expect(pkOk.value.serial).toBe(9007199254740993n);
      expect(pkOk.value.payload).toBeInstanceOf(Uint8Array);
    });

    it("supports whitelist, forbidNonWhitelisted, transform: false, skip*Properties, stopAtFirstError, and inheritance", () => {
      // Default rejects non-whitelisted properties
      const rejected = validateEntity(UserEntity, {
        username: "grace",
        displayName: "Grace",
        age: 35,
        isAdmin: true,
      });
      expect(rejected.valid).toBe(false);
      expect(rejected.errors[0]?.property).toBe("isAdmin");
      expect(rejected.errors[0]?.constraints?.whitelistValidation).toBe(
        "property isAdmin should not exist",
      );

      // forbidNonWhitelisted: false strips unknown properties cleanly
      const stripped = validateEntity(
        UserEntity,
        {
          username: "grace",
          displayName: "Grace",
          age: 35,
          isAdmin: true,
        },
        { forbidNonWhitelisted: false },
      );
      expect(stripped.valid).toBe(true);
      expect(stripped.value).toBeInstanceOf(UserEntity);
      expect("isAdmin" in (stripped.value as object)).toBe(false);

      // transform: false skips coercion and returns plain whitelisted object without mutating input
      const rawInput = {
        username: "grace",
        displayName: "Grace",
        age: "35",
        extra: 1,
      };
      const noTransformStrict = validateEntity(UserEntity, rawInput, {
        transform: false,
        forbidNonWhitelisted: false,
      });
      expect(noTransformStrict.valid).toBe(false); // "35" not coerced when transform: false
      expect(noTransformStrict.errors[0]?.constraints?.isInt).toBeDefined();

      const rawValid = {
        username: "grace",
        displayName: "Grace",
        age: 35,
        extra: 1,
      };
      const plainWhitelisted = validateEntity(UserEntity, rawValid, {
        transform: false,
        forbidNonWhitelisted: false,
      });
      expect(plainWhitelisted.valid).toBe(true);
      expect(plainWhitelisted.value).not.toBeInstanceOf(UserEntity);
      expect(plainWhitelisted.value as unknown).toEqual({
        username: "grace",
        displayName: "Grace",
        age: 35,
      });
      expect(rawValid.extra).toBe(1);

      // transform: false + whitelist: false returns exact input reference
      const passthrough = validateEntity(UserEntity, rawValid, {
        transform: false,
        whitelist: false,
      });
      expect(passthrough.valid).toBe(true);
      expect(passthrough.value).toBe(rawValid as unknown as UserEntity);

      // stopAtFirstError keeps only one failing constraint per column
      const stopped = validateEntity(
        UserEntity,
        { username: "!", displayName: "Ok", age: 25 },
        { stopAtFirstError: true },
      );
      expect(stopped.valid).toBe(false);
      expect(Object.keys(stopped.errors[0]?.constraints ?? {})).toHaveLength(1);

      // skipMissingProperties allows partial PATCH payloads
      const partial = validateEntity(
        UserEntity,
        { age: 40 },
        { skipMissingProperties: true },
      );
      expect(partial.valid).toBe(true);
      expect(partial.value.age).toBe(40);

      // Entity inheritance (DerivedArticleEntity inherits id/createdAt from BaseRecordEntity)
      const inherited = validateEntity(DerivedArticleEntity, {
        title: "Bunest Architecture",
        priority: "2",
      });
      expect(inherited.valid).toBe(true);
      expect(inherited.value).toBeInstanceOf(DerivedArticleEntity);
      expect(inherited.value).toBeInstanceOf(BaseRecordEntity);
      expect(inherited.value.priority).toBe(2);

      // Rejects prototype pollution keys & non-objects & undecorated classes
      const polluted = JSON.parse(
        '{"username":"ada","displayName":"Ada","age":25,"__proto__":{"polluted":true}}',
      );
      const pollutedRes = validateEntity(UserEntity, polluted);
      expect(pollutedRes.valid).toBe(false);
      expect(pollutedRes.errors[0]?.constraints?.forbiddenKey).toBeDefined();

      expect(validateEntity(UserEntity, null).valid).toBe(false);
      expect(validateEntity(UserEntity, []).valid).toBe(false);
      expect(() => validateEntity(UndecoratedClass, {})).toThrow(TypeError);
    });
  });

  describe("ValidationPipe integration with @Entity() and hybrid class-validator entities", () => {
    it("preserves canonical ValidationPipe identity with @bunest/common and validates pure @Entity payloads", async () => {
      expect(ValidationPipe).toBe(CommonPkg.ValidationPipe);

      const pipe = new ValidationPipe();
      const valid = (await pipe.transform(
        {
          username: "linus_t",
          displayName: "Linus",
          age: "32",
          active: "true",
          role: "admin",
        },
        { type: "body", metatype: UserEntity },
      )) as UserEntity;

      expect(valid).toBeInstanceOf(UserEntity);
      expect(valid.username).toBe("linus_t");
      expect(valid.age).toBe(32);
      expect(valid.active).toBe(true);
      expect(valid.getLabel()).toBe("linus_t (admin)");

      // Invalid payload throws normalized ADR-009 BadRequestException without leaking values
      const err = await expectValidationHttpException(
        pipe.transform(
          {
            username: "!",
            displayName: "Linus",
            age: 5,
            role: "invalid_role",
            rogueField: "secret-val",
          },
          { type: "body", metatype: UserEntity },
        ),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      const body = err.getResponse() as unknown as ValidationErrorResponse;
      expect(body.statusCode).toBe(400);
      expect(body.message).toBe("Validation failed");
      expect(JSON.stringify(body)).not.toContain("secret-val");

      const fields = body.details.map((d) => d.field);
      expect(fields).toContain("username");
      expect(fields).toContain("age");
      expect(fields).toContain("role");
      expect(fields).toContain("rogueField");

      // Respects errorFormat: "grouped", errorHttpStatusCode: 422, and BODY_SANITIZED_SYMBOL fast path
      const grouped422Pipe = new ValidationPipe({
        errorFormat: "grouped",
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      const err422 = await expectValidationHttpException(
        grouped422Pipe.transform(
          { username: "a", displayName: "Valid", age: 20 },
          { type: "body", metatype: UserEntity },
        ),
      );
      expect(err422).toBeInstanceOf(UnprocessableEntityException);
      expect((err422.getResponse() as { message: Record<string, string[]> }).message.username).toBeDefined();

      const sanitized: Record<PropertyKey, unknown> = {
        username: "ada_ok",
        displayName: "Ada",
        age: 29,
      };
      Object.defineProperty(sanitized, BODY_SANITIZED_SYMBOL, {
        value: true,
        enumerable: false,
      });
      const fastResult = await pipe.transform(sanitized, {
        type: "body",
        metatype: UserEntity,
      });
      expect(fastResult).toBeInstanceOf(UserEntity);
    });

    it("merges @Entity/@Column with class-validator & class-transformer without duplicating errors or breaking whitelist", async () => {
      const pipe = new ValidationPipe();

      // Valid hybrid payload: @Transform trims name, @Column coerces age, @IsEmail passes, cvOnlyNote allowed!
      const valid = (await pipe.transform(
        {
          name: "  Grace Hopper  ",
          email: "grace@bunest.dev",
          age: "42",
          cvOnlyNote: "pioneer",
        },
        { type: "body", metatype: HybridUserEntity },
      )) as HybridUserEntity;

      expect(valid).toBeInstanceOf(HybridUserEntity);
      expect(valid.name).toBe("Grace Hopper");
      expect(valid.email).toBe("grace@bunest.dev");
      expect(valid.age).toBe(42);
      expect(valid.bio).toBeUndefined(); // @IsOptional respected even though @Column defaults nullable: false
      expect(valid.cvOnlyNote).toBe("pioneer");

      // Invalid hybrid payload: overlapping @Column({ min: 18 }) + @Min(18) must NOT duplicate `min` error!
      const err = await expectValidationHttpException(
        pipe.transform(
          {
            name: " A ", // trimmed to "A" -> fails @Column({ minLength: 2 })
            email: "not-an-email", // fails @IsEmail()
            age: 12, // fails BOTH @Column({ min: 18 }) and @Min(18) -> deduplicated!
            unknownProp: true, // fails whitelistValidation
          },
          { type: "body", metatype: HybridUserEntity },
        ),
      );

      const body = err.getResponse() as unknown as ValidationErrorResponse;
      const byField = new Map(body.details.map((d) => [d.field, d]));

      expect(byField.get("name")?.constraints.minLength).toBeDefined();
      expect(byField.get("email")?.constraints.isEmail).toBeDefined();
      expect(byField.get("unknownProp")?.constraints.whitelistValidation).toBeDefined();

      // Exactly ONE error entry for `age` with custom class-validator message taking precedence
      const ageDetails = body.details.filter((d) => d.field === "age");
      expect(ageDetails).toHaveLength(1);
      expect(ageDetails[0]?.constraints).toEqual({
        min: "must be at least 18 years old",
      });
      expect(ageDetails[0]?.messages).toEqual(["must be at least 18 years old"]);

      // Coerced integer on `age: "25"` must NOT trigger spurious class-validator @IsInt() failure when another field fails
      const partialFail = await expectValidationHttpException(
        pipe.transform(
          {
            name: "A", // fails minLength
            email: "grace@bunest.dev",
            age: "25", // valid coerced integer!
          },
          { type: "body", metatype: HybridUserEntity },
        ),
      );
      const partialFields = (
        partialFail.getResponse() as unknown as ValidationErrorResponse
      ).details.map((d) => d.field);
      expect(partialFields).toEqual(["name"]);

      // `forbidNonWhitelisted: false` strips unknown props while keeping BOTH @Column and cv-only props
      const stripPipe = new ValidationPipe({ forbidNonWhitelisted: false });
      const stripped = (await stripPipe.transform(
        {
          name: "Ada",
          email: "ada@bunest.dev",
          age: 28,
          cvOnlyNote: "hello",
          dropMe: 123,
        },
        { type: "body", metatype: HybridUserEntity },
      )) as HybridUserEntity & Record<string, unknown>;
      expect(stripped.name).toBe("Ada");
      expect(stripped.cvOnlyNote).toBe("hello");
      expect("dropMe" in stripped).toBe(false);
    });

    it("supports hasValidationRules() for @Entity subclasses in custom ValidationPipe extensions", async () => {
      class InspectPipe extends ValidationPipe {
        checkRules(cls: CommonPkg.Type<unknown>) {
          return this.hasValidationRules(cls);
        }
      }
      const pipe = new InspectPipe();
      expect(await pipe.checkRules(UserEntity)).toBe(true);
      expect(await pipe.checkRules(UndecoratedClass)).toBe(false);
    });
  });
});
