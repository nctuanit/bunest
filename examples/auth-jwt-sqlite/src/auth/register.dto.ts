import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
} from "@bunest/validation/validator";

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];
}
