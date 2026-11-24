import {
  Body,
  Catch,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@bunest/core";
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  DocumentBuilder,
  SwaggerModule,
} from "@bunest/swagger";
import { ValidationPipe } from "@bunest/validation";
import type { BunestApplication } from "@bunest/core";
import { CreateUserDto, UpdateUserDto } from "./users.dto";

export interface UserRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly age?: number;
  readonly createdAt: string;
}

@Catch(HttpException)
export class ApiExceptionFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost): Response {
    const req = host.switchToHttp().getRequest<Request>();
    const status = exception.getStatus();
    const raw = exception.getResponse();
    const payload =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : { message: String(raw) };

    return Response.json(
      {
        ...payload,
        statusCode: status,
        path: new URL(req.url).pathname,
        timestamp: new Date().toISOString(),
      },
      { status },
    );
  }
}

@Injectable()
export class UsersService {
  private readonly store = new Map<string, UserRecord>();
  private seq = 0;
  public createInvocations = 0;

  findAll(): UserRecord[] {
    return [...this.store.values()];
  }

  findOne(id: string): UserRecord {
    const user = this.store.get(id);
    if (!user) {
      throw new NotFoundException(`User "${id}" not found`);
    }
    return user;
  }

  create(dto: CreateUserDto): UserRecord {
    this.createInvocations++;
    for (const existing of this.store.values()) {
      if (existing.email.toLowerCase() === dto.email.toLowerCase()) {
        throw new ConflictException(`Email "${dto.email}" is already in use`);
      }
    }
    const id = `usr_${++this.seq}`;
    const record: UserRecord = {
      id,
      name: dto.name,
      email: dto.email,
      age: dto.age,
      createdAt: new Date().toISOString(),
    };
    this.store.set(id, record);
    return record;
  }

  update(id: string, dto: UpdateUserDto): UserRecord {
    const existing = this.findOne(id);
    const updated: UserRecord = {
      ...existing,
      name: dto.name ?? existing.name,
      email: dto.email ?? existing.email,
      age: dto.age !== undefined ? dto.age : existing.age,
    };
    this.store.set(id, updated);
    return updated;
  }

  remove(id: string): void {
    this.findOne(id);
    this.store.delete(id);
  }
}

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

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

@Module({
  imports: [UsersModule],
})
export class AppModule {}

export function configureRestCrudApp(app: BunestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Bunest REST CRUD API")
    .setDescription("Flagship Bunest Users CRUD API with OpenAPI 3.1")
    .setVersion("1.0.0")
    .addTag("users")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("/docs", app, document);
}
