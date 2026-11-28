import { describe, expect, it } from "bun:test";
import {
  CompositionType,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
  Prop,
  ValidationPipe,
  getPropDocMetadata,
} from "../src/index";
import { instanceToPlain, plainToInstance } from "../src/transformer/index";
import { getMetadataStorage } from "../src/validator/index";

describe("@Prop() unified decorator", () => {
  class AddressDto {
    @Prop({ minLength: 2, description: "City name" })
    city!: string;

    @Prop({ matches: /^\d{5}$/, optional: true })
    zip?: string;
  }

  class TagDto {
    @Prop({ notEmpty: true })
    label!: string;
  }

  class CreateUserDto {
    @Prop({
      email: true,
      description: "Primary user email",
      example: "dev@bunest.dev",
    })
    email!: string;

    @Prop({ int: true, min: 18, max: 120, optional: true, coerce: true })
    age?: number;

    @Prop({ boolean: true, optional: true, coerce: true })
    active?: boolean;

    @Prop({ nullable: true, string: true })
    nickname!: string | null;

    @Prop({ nested: true })
    address!: AddressDto;

    @Prop({ nested: () => TagDto, each: true, minItems: 1 })
    tags!: TagDto[];

    @Prop({ exclude: true, optional: true })
    secret?: string;

    @Prop({ expose: "display_name", optional: true })
    displayName?: string;
  }

  it("validates and transforms nested objects, nested arrays, and explicit coerced fields", async () => {
    const pipe = new ValidationPipe();
    const result = (await pipe.transform(
      {
        email: "dev@bunest.dev",
        age: "25",
        active: "false",
        nickname: null,
        address: { city: "Hanoi", zip: "10000" },
        tags: [{ label: "typescript" }],
        display_name: "Bunest Dev",
      },
      { type: "body", metatype: CreateUserDto },
    )) as CreateUserDto;

    expect(result).toBeInstanceOf(CreateUserDto);
    expect(result.email).toBe("dev@bunest.dev");
    expect(result.age).toBe(25);
    expect(result.active).toBe(false); // safe boolean coercion: "false" -> false
    expect(result.nickname).toBeNull();
    expect(result.address).toBeInstanceOf(AddressDto);
    expect(result.address.city).toBe("Hanoi");
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0]).toBeInstanceOf(TagDto);
    expect(result.tags[0]!.label).toBe("typescript");
    expect(result.displayName).toBe("Bunest Dev");
  });

  it("rejects invalid email, out-of-range coerced int, invalid boolean string, and empty nested array", async () => {
    const pipe = new ValidationPipe();

    await expect(
      pipe.transform(
        {
          email: "not-an-email",
          age: "12",
          active: "maybe",
          nickname: "ok",
          address: { city: "A" },
          tags: [],
        },
        { type: "body", metatype: CreateUserDto },
      ),
    ).rejects.toThrow();
  });

  it("requires nullable-only property to be present (rejects undefined, accepts null)", async () => {
    class NullableOnlyDto {
      @Prop({ nullable: true, string: true })
      bio!: string | null;
    }
    const pipe = new ValidationPipe();

    const withNull = (await pipe.transform(
      { bio: null },
      { type: "body", metatype: NullableOnlyDto },
    )) as NullableOnlyDto;
    expect(withNull.bio).toBeNull();

    await expect(
      pipe.transform({}, { type: "body", metatype: NullableOnlyDto }),
    ).rejects.toThrow();
  });

  it("respects ADR-009: does NOT coerce primitives unless coerce: true is explicitly set", async () => {
    class StrictNumberDto {
      @Prop({ int: true })
      count!: number;
    }
    const pipe = new ValidationPipe();

    await expect(
      pipe.transform({ count: "42" }, { type: "body", metatype: StrictNumberDto }),
    ).rejects.toThrow();
  });

  it("supports serialization (@Exclude / @Expose rename)", () => {
    const instance = plainToInstance(CreateUserDto, {
      email: "a@b.com",
      nickname: null,
      address: { city: "Hanoi" },
      tags: [{ label: "bun" }],
      secret: "top-secret",
      display_name: "Alice",
    });

    const plain = instanceToPlain(instance);
    expect(plain.secret).toBeUndefined();
    expect(plain.display_name).toBe("Alice");
  });

  it("propagates PropDocMetadata across inheritance and MappedTypes (PartialType, PickType, OmitType)", () => {
    class PartialUserDto extends PartialType(CreateUserDto) {}
    class PickEmailDto extends PickType(CreateUserDto, ["email"] as const) {}
    class OmitEmailDto extends OmitType(CreateUserDto, ["email"] as const) {}

    const partialMeta = getPropDocMetadata(PartialUserDto);
    expect(partialMeta.get("email")?.description).toBe("Primary user email");
    expect(partialMeta.get("email")?.example).toBe("dev@bunest.dev");

    const pickMeta = getPropDocMetadata(PickEmailDto);
    expect(pickMeta.get("email")?.description).toBe("Primary user email");
    expect(pickMeta.has("nickname")).toBe(false);

    const omitMeta = getPropDocMetadata(OmitEmailDto);
    expect(omitMeta.has("email")).toBe(false);
    expect(omitMeta.get("nickname")?.nullable).toBe(true);
  });

  it("rejects missing required @Prop({ nested: true }) and allows null only when nullable: true", async () => {
    class RequiredNestedDto {
      @Prop({ nested: true })
      address!: AddressDto;
    }
    class NullableNestedDto {
      @Prop({ nested: true, nullable: true })
      address!: AddressDto | null;
    }
    class OptionalNestedDto {
      @Prop({ nested: true, optional: true })
      address?: AddressDto;
    }
    const pipe = new ValidationPipe();

    await expect(
      pipe.transform({}, { type: "body", metatype: RequiredNestedDto }),
    ).rejects.toThrow();
    await expect(
      pipe.transform(
        { address: null },
        { type: "body", metatype: RequiredNestedDto },
      ),
    ).rejects.toThrow();

    await expect(
      pipe.transform({}, { type: "body", metatype: NullableNestedDto }),
    ).rejects.toThrow();
    const withNull = (await pipe.transform(
      { address: null },
      { type: "body", metatype: NullableNestedDto },
    )) as NullableNestedDto;
    expect(withNull.address).toBeNull();

    const withOmitted = (await pipe.transform(
      {},
      { type: "body", metatype: OptionalNestedDto },
    )) as OptionalNestedDto;
    expect(withOmitted.address).toBeUndefined();
  });

  it("enforces IsArray on @Prop({ each: true }) and rejects scalar values", async () => {
    class ScalarArrayDto {
      @Prop({ string: true, each: true })
      tags!: string[];

      @Prop({ min: 0, each: true, coerce: true })
      scores!: number[];
    }
    const pipe = new ValidationPipe();

    await expect(
      pipe.transform(
        { tags: "not-an-array", scores: [10] },
        { type: "body", metatype: ScalarArrayDto },
      ),
    ).rejects.toThrow();

    await expect(
      pipe.transform(
        { tags: ["ok"], scores: [Infinity] },
        { type: "body", metatype: ScalarArrayDto },
      ),
    ).rejects.toThrow();

    const valid = (await pipe.transform(
      { tags: ["a", "b"], scores: ["1", "42.5"] },
      { type: "body", metatype: ScalarArrayDto },
    )) as ScalarArrayDto;
    expect(valid.tags).toEqual(["a", "b"]);
    expect(valid.scores).toEqual([1, 42.5]);
  });

  it("safely coerces strings, numbers (rejecting Infinity/empty), booleans, and dates", async () => {
    class CoerceEdgeDto {
      @Prop({ coerce: true })
      name!: string;

      @Prop({ number: true, coerce: true })
      amount!: number;

      @Prop({ date: true, coerce: true })
      createdAt!: Date;

      @Prop({ date: true, each: true, coerce: true, optional: true })
      dates?: Date[];
    }
    const pipe = new ValidationPipe();

    // Object/array must NOT coerce to "[object Object]" / "1,2"
    await expect(
      pipe.transform(
        { name: { evil: 1 }, amount: "10", createdAt: "2026-01-01T00:00:00Z" },
        { type: "body", metatype: CoerceEdgeDto },
      ),
    ).rejects.toThrow();

    // "Infinity", "-Infinity", and "" must remain uncoerced in plainToInstance and fail validation
    const infPlain = plainToInstance(CoerceEdgeDto, {
      name: 123,
      amount: "Infinity",
      createdAt: "",
    });
    expect(infPlain.name).toBe("123");
    expect(infPlain.amount).toBe("Infinity" as unknown as number);
    expect(infPlain.createdAt).toBe("" as unknown as Date);

    await expect(
      pipe.transform(
        { name: "ok", amount: "Infinity", createdAt: "2026-01-01T00:00:00Z" },
        { type: "body", metatype: CoerceEdgeDto },
      ),
    ).rejects.toThrow();

    await expect(
      pipe.transform(
        { name: "ok", amount: "   ", createdAt: "2026-01-01T00:00:00Z" },
        { type: "body", metatype: CoerceEdgeDto },
      ),
    ).rejects.toThrow();

    await expect(
      pipe.transform(
        { name: "ok", amount: "10", createdAt: "not-a-date" },
        { type: "body", metatype: CoerceEdgeDto },
      ),
    ).rejects.toThrow();

    const ok = (await pipe.transform(
      {
        name: 42,
        amount: "3.14",
        createdAt: "2026-01-01T00:00:00.000Z",
        dates: ["2026-02-01T00:00:00.000Z"],
      },
      { type: "body", metatype: CoerceEdgeDto },
    )) as CoerceEdgeDto;
    expect(ok.name).toBe("42");
    expect(ok.amount).toBe(3.14);
    expect(ok.createdAt).toBeInstanceOf(Date);
    expect(ok.dates?.[0]).toBeInstanceOf(Date);
  });

  it("sets each: true on ValidateNested metadata for nested array inferred from design:type", () => {
    class AutoEachNestedDto {
      @Prop({ nested: () => TagDto })
      tags!: TagDto[];
    }
    const metas = getMetadataStorage().getTargetValidationMetadatas(
      AutoEachNestedDto,
      "",
      false,
      false,
    );
    const nestedMeta = metas.find(
      (m) => m.propertyName === "tags" && m.type === "nestedValidation",
    );
    expect(nestedMeta?.each).toBe(true);
  });

  it("supports exclude options ({ toPlainOnly: true }) for input-accepted, output-hidden fields", async () => {
    class AccountDto {
      @Prop({ minLength: 6, exclude: { toPlainOnly: true } })
      password!: string;
    }
    const pipe = new ValidationPipe();
    const instance = (await pipe.transform(
      { password: "secret-password" },
      { type: "body", metatype: AccountDto },
    )) as AccountDto;
    expect(instance.password).toBe("secret-password");

    const plain = instanceToPlain(instance);
    expect(plain.password).toBeUndefined();
  });

  it("propagates PropDocMetadata (including array examples) across IntersectionType and CompositionType", () => {
    class PartADto {
      @Prop({ description: "User ID", examples: ["u_1", "u_2"] })
      id!: string;
    }
    class PartBDto {
      @Prop({ description: "Role name", example: "admin" })
      role!: string;
    }
    class IntersectedDto extends IntersectionType(PartADto, PartBDto) {}
    class ComposedDto extends CompositionType(PartADto, PartBDto) {}

    for (const Cls of [IntersectedDto, ComposedDto]) {
      const meta = getPropDocMetadata(Cls);
      expect(meta.get("id")?.description).toBe("User ID");
      expect(meta.get("id")?.examples).toEqual(["u_1", "u_2"]);
      expect(meta.get("role")?.description).toBe("Role name");
      expect(meta.get("role")?.example).toBe("admin");
    }
  });
});
