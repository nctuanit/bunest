import {
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Secret,
  UnauthorizedException,
} from "@bunest/core";
import type { BunestApplication } from "@bunest/core";
import {
  CurrentUser,
  JwtService,
  PasswordService,
  Public,
  Roles,
  SecurityModule,
} from "@bunest/security";
import {
  Column,
  CreateDateColumn,
  CrudRepository,
  Entity,
  OrmMigrationRunner,
  OrmModule,
  OrmRepository,
  PrimaryGeneratedColumn,
  Transactional,
  type OrmMigration,
} from "@bunest/orm";
import { ValidationPipe } from "@bunest/validation";
import { CreateTaskDto, LoginDto, RegisterDto } from "./auth.dto";

export const AUTH_JWT_SECRET =
  Bun.env.JWT_SECRET ?? "bunest-demo-jwt-secret-key-min-32-chars!!";

export interface AuthenticatedUser {
  readonly sub: string;
  readonly email: string;
  readonly roles: string[];
}

export const AUTH_SQLITE_MIGRATIONS: readonly OrmMigration[] = [
  {
    id: "001_create_users",
    up: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        roles TEXT NOT NULL
      );
    `,
    down: "DROP TABLE users;",
  },
  {
    id: "002_create_tasks",
    up: `
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE task_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        action TEXT NOT NULL
      );
    `,
    down: "DROP TABLE task_audit; DROP TABLE tasks;",
  },
];

@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text", unique: true })
  email!: string;

  @Column({ name: "password_hash", type: "text" })
  @Secret()
  passwordHash!: string;

  @Column({ type: "json" })
  roles!: string[];
}

@Entity("tasks")
export class TaskEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "user_id", type: "integer" })
  userId!: number;

  @Column({ type: "text" })
  title!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}

@OrmRepository(UserEntity)
export abstract class UserRepository extends CrudRepository<UserEntity, number> {
  abstract findByEmail(email: string): Promise<UserEntity | null>;
  abstract existsByEmail(email: string): Promise<boolean>;

  async countRegisteredUsers(): Promise<number> {
    const row = await this.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users",
    );
    return Number(row?.count ?? 0);
  }
}

@OrmRepository(TaskEntity)
export abstract class TaskRepository extends CrudRepository<TaskEntity, number> {
  async findAllForUser(userId: number): Promise<TaskEntity[]> {
    return this.query<TaskEntity>(
      "SELECT id, user_id AS userId, title, created_at AS createdAt FROM tasks WHERE user_id = :userId ORDER BY id ASC",
      { userId },
    );
  }

  async recordAudit(taskId: number, action: string): Promise<number> {
    const res = await this.execute(
      "INSERT INTO task_audit (task_id, action) VALUES (:taskId, :action)",
      { taskId, action },
    );
    return res.affectedRows;
  }

  async countAuditEntries(): Promise<number> {
    const row = await this.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM task_audit",
    );
    return Number(row?.count ?? 0);
  }
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    if (await this.users.existsByEmail(email)) {
      throw new ConflictException(`User "${dto.email}" already exists`);
    }

    const hash = await this.passwords.hash(dto.password);
    const roles = dto.roles?.length ? dto.roles : ["user"];
    const created = await this.users.save({
      email,
      passwordHash: hash,
      roles,
    });

    return {
      id: created.id,
      email: created.email,
      roles: created.roles,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.users.findByEmail(dto.email.toLowerCase());
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const valid = await this.passwords.verify(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const accessToken = await this.jwt.sign(
      {
        sub: String(user.id),
        email: user.email,
        roles: user.roles,
      },
      { expiresIn: "1h" },
    );

    return { accessToken };
  }
}

@Injectable()
export class TasksService {
  constructor(
    private readonly users: UserRepository,
    private readonly tasks: TaskRepository,
  ) {}

  @Transactional()
  async createTransactional(userId: number, dto: CreateTaskDto) {
    const task = await this.tasks.save({
      userId,
      title: dto.title,
    });

    await this.tasks.recordAudit(task.id, "created");

    if (dto.failAfterInsert === "true") {
      throw new Error("Simulated transactional failure after insert");
    }

    return { id: task.id, userId, title: task.title };
  }

  listForUser(userId: number): Promise<TaskEntity[]> {
    return this.tasks.findAllForUser(userId);
  }

  async getAdminStats() {
    const [userCount, taskCount, auditCount] = await Promise.all([
      this.users.countRegisteredUsers(),
      this.tasks.count(),
      this.tasks.countAuditEntries(),
    ]);

    return { userCount, taskCount, auditCount };
  }
}

@Controller("/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("/register")
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post("/login")
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get("/me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}

@Controller("/tasks")
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTaskDto) {
    return this.tasksService.createTransactional(Number(user.sub), dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.tasksService.listForUser(Number(user.sub));
  }
}

@Controller("/admin")
export class AdminController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly migrations: OrmMigrationRunner,
  ) {}

  @Roles("admin")
  @Get("/stats")
  async stats() {
    const migrationStatus = await this.migrations.status();
    return {
      ...(await this.tasksService.getAdminStats()),
      appliedMigrations: migrationStatus.applied.map((m) => m.id),
    };
  }
}

export function createAuthSqliteModule(filename: string = ":memory:") {
  @Module({
    imports: [
      OrmModule.forRoot({
        type: "sqlite",
        database: filename,
        migrations: AUTH_SQLITE_MIGRATIONS,
        autoMigrate: true,
      }),
      OrmModule.forFeature([UserRepository, TaskRepository]),
      SecurityModule.forRoot({
        jwt: {
          secret: AUTH_JWT_SECRET,
          signOptions: { algorithm: "HS256" },
          verifyOptions: { algorithms: ["HS256"] },
        },
        throttler: {
          throttlers: [{ name: "default", ttl: 60_000, limit: 100 }],
        },
        globalGuards: true,
        securityHeaders: true,
      }),
    ],
    controllers: [AuthController, TasksController, AdminController],
    providers: [PasswordService, AuthService, TasksService],
  })
  class AuthSqliteAppModule {}

  return AuthSqliteAppModule;
}

export const AppModule = createAuthSqliteModule(
  Bun.env.SQLITE_FILE ?? ":memory:",
);

export function configureAuthSqliteApp(app: BunestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
