import { describe, expect, it } from "bun:test";
import { Transform, plainToInstance } from "../src/transformer";
import { IsEmail, IsInt, IsString, Min, validate } from "../src/validator";
import {
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
  applyIsOptionalDecorator,
  applyValidateIfDefinedDecorator,
  inheritPropertyInitializers,
  inheritTransformationMetadata,
  inheritValidationMetadata,
  type MappedType,
} from "../src";

class AccountDto {
  @IsEmail()
  email!: string;

  @IsString()
  role = "user";

  @IsInt()
  @Min(1)
  retries = 3;

  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  code!: string;

  helperMethod(): string {
    return this.role;
  }
}

class BillingDto {
  @IsString()
  plan = "free";
}

class RegionDto {
  @IsString()
  region = "us-east-1";
}

describe("mapped-types NestJS v12 Parity (10/10 exports & signatures)", () => {
  it("PartialType supports skipNullProperties: true (default) vs false and inherits property initializers", async () => {
    class DefaultPartialDto extends PartialType(AccountDto) {}
    class StrictNullPartialDto extends PartialType(AccountDto, {
      skipNullProperties: false,
    }) {}

    // Property initializers inherited in derived constructor
    const inst = new DefaultPartialDto();
    expect(inst.role).toBe("user");
    expect(inst.retries).toBe(3);

    // Default skipNullProperties: true -> null & undefined both accepted
    const withNullDefault = plainToInstance(DefaultPartialDto, {
      email: null,
      code: undefined,
    });
    expect(await validate(withNullDefault)).toHaveLength(0);

    // skipNullProperties: false -> undefined accepted, null REJECTED!
    const withUndefinedStrict = plainToInstance(StrictNullPartialDto, {
      email: undefined,
    });
    expect(await validate(withUndefinedStrict)).toHaveLength(0);

    const withNullStrict = plainToInstance(StrictNullPartialDto, {
      email: null,
    });
    const nullErrors = await validate(withNullStrict);
    expect(nullErrors.map((e) => e.property)).toContain("email");
  });

  it("PickType and OmitType inherit only matching property initializers", () => {
    class PickedDto extends PickType(AccountDto, ["role"] as const) {}
    class OmittedDto extends OmitType(AccountDto, ["role"] as const) {}

    const picked = new PickedDto();
    expect(picked.role).toBe("user");
    expect(
      (picked as unknown as Record<string, unknown>).retries,
    ).toBeUndefined();

    const omitted = new OmittedDto();
    expect(omitted.retries).toBe(3);
    expect(
      (omitted as unknown as Record<string, unknown>).role,
    ).toBeUndefined();
  });

  it("IntersectionType is variadic across 3+ DTO classes and inherits validators, transforms, and initializers", async () => {
    class CombinedDto extends IntersectionType(
      PickType(AccountDto, ["email", "role", "code"] as const),
      BillingDto,
      RegionDto,
    ) {}

    const instance = new CombinedDto();
    expect(instance.role).toBe("user");
    expect(instance.plan).toBe("free");
    expect(instance.region).toBe("us-east-1");

    const ok = plainToInstance(CombinedDto, {
      email: "ada@example.com",
      code: "  abc  ",
    });
    expect(ok.code).toBe("ABC");
    expect(ok.plan).toBe("free");
    expect(ok.region).toBe("us-east-1");
    expect(await validate(ok)).toHaveLength(0);

    const bad = plainToInstance(CombinedDto, {
      email: "bad-email",
      code: 42,
      plan: 99,
      region: false,
    });
    const props = (await validate(bad)).map((e) => e.property).sort();
    expect(props).toEqual(["code", "email", "plan", "region"]);
  });

  it("exports standalone helpers: applyIsOptionalDecorator, applyValidateIfDefinedDecorator, inheritValidationMetadata, inheritTransformationMetadata, inheritPropertyInitializers, MappedType", async () => {
    class ManualOptionalDto {
      @IsString()
      a?: string | null;

      @IsString()
      b?: string | null;
    }
    applyIsOptionalDecorator(ManualOptionalDto, "a");
    applyValidateIfDefinedDecorator(ManualOptionalDto, "b");

    // a allows null, b rejects null (only allows undefined)
    expect(
      await validate(
        Object.assign(new ManualOptionalDto(), { a: null, b: undefined }),
      ),
    ).toHaveLength(0);
    const errs = await validate(
      Object.assign(new ManualOptionalDto(), { a: null, b: null }),
    );
    expect(errs.map((e) => e.property)).toEqual(["b"]);

    // inheritValidationMetadata & inheritTransformationMetadata directly
    class ManualCloneDto {}
    const inheritedKeys = inheritValidationMetadata(
      AccountDto,
      ManualCloneDto,
      (k) => k === "email" || k === "code",
    );
    expect(inheritedKeys).toBeDefined();
    expect(new Set(inheritedKeys)).toEqual(new Set(["email", "code"]));
    expect(
      Reflect.getMetadata("design:type", ManualCloneDto.prototype, "email"),
    ).toBe(String);

    inheritTransformationMetadata(
      AccountDto,
      ManualCloneDto,
      (k) => k === "code",
    );
    const cloned = plainToInstance(ManualCloneDto, {
      email: "test@example.com",
      code: "  xyz  ",
    }) as Record<string, unknown>;
    expect(cloned.code).toBe("XYZ");
    expect(await validate(cloned)).toHaveLength(0);

    // inheritPropertyInitializers preserves already-set values & ignores throwing ctors
    const targetObj: Record<string, unknown> = { role: "custom-admin" };
    inheritPropertyInitializers(targetObj, AccountDto);
    expect(targetObj.role).toBe("custom-admin");
    expect(targetObj.retries).toBe(3);

    class ThrowingCtor {
      constructor() {
        throw new Error("requires args");
      }
    }
    expect(() => inheritPropertyInitializers({}, ThrowingCtor)).not.toThrow();

    // MappedType<T> interface compile-time verification
    const mappedCtor: MappedType<{ email?: string }> = PartialType(
      PickType(AccountDto, ["email"] as const),
    );
    expect(new mappedCtor()).toBeInstanceOf(mappedCtor);
  });
});
