import { Type } from "class-transformer";
import {
  IsEmail,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
  registerDecorator,
  type ValidationOptions,
} from "class-validator";
import { Injectable } from "../../src";

export function IsNotBlockedEmail(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: "isNotBlockedEmail",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        async validate(value: unknown): Promise<boolean> {
          await Promise.resolve();
          return typeof value === "string" && !value.endsWith("@blocked.test");
        },
        defaultMessage() {
          return "Email domain is blocked";
        },
      },
    });
  };
}

export class AddressDto {
  @IsString()
  @MinLength(2)
  city!: string;

  @IsString()
  country!: string;
}

export class CreateSpikeUserDto {
  @IsEmail()
  @IsNotBlockedEmail()
  email!: string;

  @IsString()
  @MinLength(3)
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(18)
  age!: number;

  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;
}

export class SpikeUserResult {
  constructor(
    public readonly id: string,
    public readonly email: string,
  ) {}
}

@Injectable()
export class ImportedSpikeRepository {
  readonly kind = "spike-repo";
}

@Injectable()
export class ImportedSpikeService {
  constructor(public readonly repo: ImportedSpikeRepository) {}
}
