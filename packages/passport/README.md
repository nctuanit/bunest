# @bunest/passport

Drop-in 1:1 NestJS `@nestjs/passport` (v12) migration facade for **Bunest**, powered natively by `@bunest/security` with zero external runtime dependencies.

## Features

- **Drop-In `@nestjs/passport` Parity**: Replace `@nestjs/passport` imports with `@bunest/passport` verbatim.
- **Strategy Mixin & Registry**: Define strategies with `PassportStrategy(Strategy, name)` or `AbstractStrategy` and manage registrations via `AuthStrategyRegistry`.
- **Guard Factory**: Protect HTTP, GraphQL, or WebSocket routes with `AuthGuard("jwt")` or multi-strategy `AuthGuard(["jwt", "api-key"])`.
- **Session Serialization**: Built-in `PassportSerializer` base class for session-based authentication flows.
- **Zero External Runtime Dependencies**: Powered directly by `@bunest/security` without requiring Node Passport middleware.

## Installation

```bash
bun add @bunest/passport
```

## Quick Start

```ts
import { Controller, Get, Injectable, Module, UseGuards } from "@bunest/common";
import { AuthGuard, PassportModule, PassportStrategy } from "@bunest/passport";
import { JwtAuthStrategy } from "@bunest/security";

@Injectable()
export class JwtStrategy extends PassportStrategy(JwtAuthStrategy, "jwt") {
  constructor() {
    super({ secret: process.env.JWT_SECRET ?? "dev-secret" });
  }

  async validate(payload: { sub: string; email: string }) {
    return { userId: payload.sub, email: payload.email };
  }
}

@Controller("profile")
export class ProfileController {
  @Get()
  @UseGuards(AuthGuard("jwt"))
  getProfile() {
    return { ok: true };
  }
}

@Module({
  imports: [PassportModule.register({ defaultStrategy: "jwt" })],
  controllers: [ProfileController],
  providers: [JwtStrategy],
})
export class AppModule {}
```

## Key Exports

- **Module & Options**: `PassportModule` (`register`, `registerAsync`), `AuthModuleOptions`, `AUTH_MODULE_OPTIONS`
- **Strategies & Guards**: `PassportStrategy`, `AbstractStrategy`, `AuthGuard`, `PassportSerializer`
- **Registry Utilities**: `AuthStrategyRegistry`, `BunestPassportInstance`, `defaultPassportInstance`
- **Types**: `IAuthGuard`, `IAuthModuleOptions`, `AuthModuleAsyncOptions`, `AuthOptionsFactory`, `AuthGuardAuthenticateOptions`, `AuthStrategy`, `AuthStrategyRegistration`, `SerializeUserFn`, `DeserializeUserFn`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
