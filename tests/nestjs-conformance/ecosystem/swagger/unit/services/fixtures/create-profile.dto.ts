import { ApiProperty } from "../../../../../../../packages/swagger/src";
import { CreateUserDto } from "./create-user.dto";

// ESM circular import guard: avoid eager design:type reference to CreateUserDto during TDZ.
type LazyCreateUserDto = CreateUserDto & {};

export class CreateProfileDto {
  @ApiProperty()
  firstname!: string;

  @ApiProperty()
  lastname!: string;

  @ApiProperty({
    type: () => CreateUserDto,
    name: "parent",
  })
  parent!: LazyCreateUserDto;
}
