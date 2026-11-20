# @bunest/prisma

Drop-in Prisma integration facade for **Bunest**, powered by `@bunest/sql` with zero external runtime dependencies. Provides DI lifecycle management, `AsyncLocalStorage` transaction propagation, and automatic Prisma-to-HTTP exception mapping.

## Features

- **Managed Client Lifecycle**: `PrismaModule` (`forRoot`, `forRootAsync`) and `PrismaService` / `PrismaServiceBase` automatically handle `$connect()`, `$disconnect()`, and `healthCheck()`.
- **AsyncLocalStorage Transactions**: Seamless interactive and batch transaction propagation via `transactionalClient` proxy.
- **Prisma Exception Filter**: `PrismaClientExceptionFilter` and `mapPrismaErrorToHttp()` map Prisma Client `P2xxx` / `P1xxx` error codes to HTTP status codes with optional custom overrides.
- **Multi-Connection DI**: Inject named or default clients using `@InjectPrisma()`, `@InjectPrismaService()`, `PRISMA_CLIENT`, and token helpers.

## Installation

```bash
bun add @bunest/prisma
```

## Quick Start

```ts
import { Controller, Get, Injectable, Module, UseFilters } from "@bunest/common";
import {
  InjectPrisma,
  PrismaClientExceptionFilter,
  PrismaModule,
  PrismaService,
  type PrismaClientLike,
} from "@bunest/prisma";

@Injectable()
export class UsersService {
  constructor(
    @InjectPrisma() private readonly prisma: PrismaClientLike,
    private readonly prismaService: PrismaService,
  ) {}

  health() {
    return this.prismaService.healthCheck();
  }
}

@Controller("users")
@UseFilters(PrismaClientExceptionFilter)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get("health")
  check() {
    return this.users.health();
  }
}

@Module({
  imports: [
    PrismaModule.forRoot({
      client: myPrismaClient,
    }),
  ],
  controllers: [UsersController],
  providers: [UsersService],
})
export class AppModule {}
```

## Key Exports

- **Module & Services**: `PrismaModule` (`forRoot`, `forRootAsync`), `PrismaService`, `PrismaServiceBase`
- **Exception Handling**: `PrismaClientExceptionFilter`, `mapPrismaErrorToHttp`, `isPrismaClientKnownRequestError`
- **Decorators & Tokens**: `InjectPrisma`, `InjectPrismaService`, `PRISMA_CLIENT`, `DEFAULT_PRISMA_CONNECTION`, `getPrismaToken`, `getPrismaServiceToken`, `getPrismaOptionsToken`
- **Types**: `PrismaClientLike`, `PrismaModuleOptions`, `PrismaModuleAsyncOptions`, `PrismaOptionsFactory`, `PrismaServiceOptions`, `PrismaKnownRequestErrorLike`, `PrismaErrorCodeStatusMap`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
