import {
  Body,
  BunestFactory,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  ValidationPipe,
} from "../../../packages/core/src/index.ts";
import { attachIpcChannel } from "./ipc";
import {
  type BenchUser,
  CreateUserDto,
  type CreateUserInput,
  createUserRecord,
  findUserById,
} from "./shared";

@Injectable()
class UsersService {
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
});

@Controller()
class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("/health")
  health(): { status: string } {
    return { status: "ok" };
  }

  @Get("/users/:id")
  getUser(@Param("id") id: string): BenchUser {
    return this.usersService.findOne(id);
  }

  @Post("/users")
  createUser(@Body() body: CreateUserInput): BenchUser {
    return this.usersService.create(body);
  }

  @Post("/users/validated")
  createValidatedUser(@Body(validationPipe) dto: CreateUserDto): BenchUser {
    return this.usersService.create(dto);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await BunestFactory.create(AppModule, { logger: false });
  const info = await app.listen({
    hostname: "127.0.0.1",
    port: 0,
  });

  attachIpcChannel(info.port, async () => {
    await app.close();
  });
}

await bootstrap();
