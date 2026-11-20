import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Exclude, Expose, Transform, Type, instanceToPlain, plainToInstance } from "class-transformer";
import { IsEmail, IsInt, IsString, Min, MinLength, validate } from "class-validator";
import {
  ApiProperty,
  SchemaExplorer,
  PartialType as SwaggerPartialType,
} from "@bunest/swagger";
import {
  CompositionType,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
} from "../src";

class BaseUserDto {
  @ApiProperty({ description: "User email" })
  @IsEmail()
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  email!: string;

  @ApiProperty({ description: "Display name" })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: "Age in years" })
  @Type(() => Number)
  @IsInt()
  @Min(18)
  age!: number;

  @Exclude()
  @IsString()
  secret!: string;
}

class AuditFieldsDto {
  @ApiProperty({ description: "Actor ID" })
  @Expose()
  @IsString()
  updatedBy!: string;
}

class TenantFieldsDto {
  @ApiProperty({ description: "Tenant ID" })
  @IsString()
  tenantId!: string;
}

describe("@bunest/mapped-types", () => {
  it("PartialType clones class-validator, class-transformer (@Type/@Transform/@Exclude), and Swagger @ApiProperty without mutating base", async () => {
    class UpdateUserDto extends PartialType(BaseUserDto) {}

    // Empty object is valid for PartialType
    const emptyInst = plainToInstance(UpdateUserDto, {});
    expect(await validate(emptyInst)).toHaveLength(0);

    // @Type(() => Number) and @Transform() cloned onto derived class!
    const transformed = plainToInstance(UpdateUserDto, {
      email: "  ADA@EXAMPLE.COM  ",
      age: "25",
      secret: "hidden",
    });
    expect(transformed.email).toBe("ada@example.com");
    expect(transformed.age).toBe(25);
    expect(await validate(transformed)).toHaveLength(0);

    // @Exclude() cloned onto derived class!
    const plain = instanceToPlain(transformed);
    expect(plain.secret).toBeUndefined();

    // Invalid partial field still rejected
    const bad = plainToInstance(UpdateUserDto, { age: "12" });
    expect((await validate(bad)).length).toBeGreaterThan(0);

    // Base class remains strictly required (unmutated)
    const baseEmpty = plainToInstance(BaseUserDto, {});
    expect((await validate(baseEmpty)).length).toBeGreaterThanOrEqual(4);

    // Swagger schema marks all properties optional on UpdateUserDto, required on BaseUserDto
    const explorer = new SchemaExplorer();
    explorer.registerDtoSchema(UpdateUserDto);
    explorer.registerDtoSchema(BaseUserDto);
    const schemas = explorer.getSchemas();
    expect(schemas.UpdateUserDto?.required).toBeUndefined();
    expect(schemas.BaseUserDto?.required).toContain("email");
    expect(SwaggerPartialType).toBe(PartialType);
  });

  it("PickType and OmitType selectively clone validation + transformer + Swagger metadata", async () => {
    class LoginDto extends PickType(BaseUserDto, ["email", "age"] as const) {}
    class PublicCreateDto extends OmitType(BaseUserDto, ["secret"] as const) {}

    const loginOk = plainToInstance(LoginDto, {
      email: "  TEST@BUNEST.DEV ",
      age: "21",
    });
    expect(loginOk.email).toBe("test@bunest.dev");
    expect(loginOk.age).toBe(21);
    expect(await validate(loginOk)).toHaveLength(0);

    const publicOk = plainToInstance(PublicCreateDto, {
      email: "a@b.co",
      name: "Ada",
      age: "30",
    });
    expect(await validate(publicOk)).toHaveLength(0);

    const explorer = new SchemaExplorer();
    explorer.registerDtoSchema(LoginDto);
    const loginProps = Object.keys(
      explorer.getSchemas().LoginDto?.properties ?? {},
    );
    expect(loginProps.sort()).toEqual(["age", "email"]);
  });

  it("IntersectionType and CompositionType combine 2+ DTO classes cleanly", async () => {
    class AuditedUserDto extends IntersectionType(
      OmitType(BaseUserDto, ["secret"] as const),
      AuditFieldsDto,
    ) {}

    class FullContextDto extends CompositionType(
      PickType(BaseUserDto, ["email"] as const),
      AuditFieldsDto,
      TenantFieldsDto,
    ) {}

    const auditedOk = plainToInstance(AuditedUserDto, {
      email: "ada@b.co",
      name: "Ada",
      age: "28",
      updatedBy: "admin",
    });
    expect(await validate(auditedOk)).toHaveLength(0);

    const fullBad = plainToInstance(FullContextDto, {
      email: "ada@b.co",
      updatedBy: "admin",
    });
    const errors = await validate(fullBad);
    expect(errors.map((e) => e.property)).toEqual(["tenantId"]);

    const fullOk = plainToInstance(FullContextDto, {
      email: "  ADA@B.CO ",
      updatedBy: "admin",
      tenantId: "t_1",
    });
    expect(fullOk.email).toBe("ada@b.co");
    expect(await validate(fullOk)).toHaveLength(0);
  });
});
