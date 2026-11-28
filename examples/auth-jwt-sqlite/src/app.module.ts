import { Module, type BunestApplication } from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { PasswordService, SecurityModule } from "@bunest/security";
import { ValidationPipe } from "@bunest/validation";
import { AdminController } from "./admin/admin.controller";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { AUTH_SQLITE_MIGRATIONS } from "./auth.migrations";
import { TaskRepository } from "./tasks/task.repository";
import { TasksController } from "./tasks/tasks.controller";
import { TasksService } from "./tasks/tasks.service";
import { UserRepository } from "./users/user.repository";

export const AUTH_JWT_SECRET =
  Bun.env.JWT_SECRET ?? "bunest-demo-jwt-secret-key-min-32-chars!!";

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
