import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  ValidationPipe,
} from "@nestjs/common";
import {
  type BenchUser,
  CreateUserDto,
  type CreateUserInput,
  createUserRecord,
  findUserById,
} from "./shared";

@Injectable()
export class UsersService {
  findOne(id: string): BenchUser {
    return findUserById(id);
  }

  create(payload: CreateUserInput): BenchUser {
    return createUserRecord(payload);
  }
}

const validationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  forbidUnknownValues: true,
});

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("health")
  health(): { status: string } {
    return { status: "ok" };
  }

  @Get("users/:id")
  getUser(@Param("id") id: string): BenchUser {
    return this.usersService.findOne(id);
  }

  @Post("users")
  createUser(@Body() body: CreateUserInput): BenchUser {
    return this.usersService.create(body);
  }

  @Post("users/validated")
  createValidatedUser(@Body(validationPipe) dto: CreateUserDto): BenchUser {
    return this.usersService.create(dto);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class AppModule {}
