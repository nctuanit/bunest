import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from "@bunest/core";
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@bunest/swagger";
import { CreateUserDto } from "./create-user.dto";
import { UpdateUserDto } from "./update-user.dto";
import { UsersService, type UserRecord } from "./users.service";

@ApiTags("users")
@Controller("/users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({ summary: "Create a new user" })
  @ApiCreatedResponse({ description: "User created successfully" })
  @ApiBadRequestResponse({ description: "DTO validation failed" })
  @Post()
  create(@Body() dto: CreateUserDto): UserRecord {
    return this.usersService.create(dto);
  }

  @ApiOperation({ summary: "List all users" })
  @ApiOkResponse({ description: "Array of users" })
  @Get()
  findAll(): UserRecord[] {
    return this.usersService.findAll();
  }

  @ApiOperation({ summary: "Get a user by ID" })
  @ApiOkResponse({ description: "Found user" })
  @ApiNotFoundResponse({ description: "User not found" })
  @Get(":id")
  findOne(@Param("id") id: string): UserRecord {
    return this.usersService.findOne(id);
  }

  @ApiOperation({ summary: "Update a user by ID" })
  @ApiOkResponse({ description: "Updated user" })
  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateUserDto): UserRecord {
    return this.usersService.update(id, dto);
  }

  @ApiOperation({ summary: "Delete a user by ID" })
  @ApiNoContentResponse({ description: "User deleted" })
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param("id") id: string): void {
    this.usersService.remove(id);
  }
}
