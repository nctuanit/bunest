# @bunest/throttler

Drop-in 1:1 NestJS `@nestjs/throttler` (v6.8) migration facade for **Bunest**, powered natively by `@bunest/security` with zero external runtime dependencies.

## Features

- **Drop-In `@nestjs/throttler` Parity**: Replace `@nestjs/throttler` imports with `@bunest/throttler` verbatim.
- **Multi-Rule Rate Limiting**: Configure named rate-limit rules (e.g. `short`, `medium`, `long`) via `ThrottlerModule.forRoot()` / `forRootAsync()` and enforce them globally or per-route with `ThrottlerGuard`.
- **Route Overrides**: Customize or bypass limits per controller/handler using `@Throttle()` and `@SkipThrottle()`.
- **Built-In Memory Storage & IP Normalization**: Includes `MemoryThrottlerStorage` / `ThrottlerStorageService` with automatic expired-key sweeping and IPv6 subnet normalization (`normalizeIp()`).
- **Duration Helpers**: Readable TTL helpers (`seconds`, `minutes`, `hours`, `days`, `weeks`).

## Installation

```bash
bun add @bunest/throttler
```

## Quick Start

```ts
import { APP_GUARD, Controller, Get, Module } from "@bunest/common";
import {
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  seconds,
} from "@bunest/throttler";

@Controller("api")
export class ApiController {
  @Get("status")
  @SkipThrottle()
  status() {
    return { ok: true };
  }

  @Get("search")
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  search() {
    return { results: [] };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: "default", ttl: seconds(60), limit: 60 },
    ]),
  ],
  controllers: [ApiController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

## Key Exports

- **Module, Guard & Storage**: `ThrottlerModule` (`forRoot`, `forRootAsync`), `ThrottlerGuard`, `ThrottlerStorage`, `ThrottlerStorageService`, `MemoryThrottlerStorage`
- **Decorators**: `Throttle`, `SkipThrottle`, `InjectThrottlerOptions`, `InjectThrottlerStorage`
- **Helpers & Errors**: `seconds`, `minutes`, `hours`, `days`, `weeks`, `normalizeIp`, `ThrottlerException`, `throttlerMessage`
- **Tokens & Constants**: `THROTTLER_OPTIONS`, `THROTTLER_STORAGE`, `THROTTLE_METADATA`, `SKIP_THROTTLE_METADATA`, `getOptionsToken`, `getStorageToken`, `DEFAULT_IPV6_SUBNET_PREFIX`, `DEFAULT_SWEEP_INTERVAL`, `MEMORY_THROTTLER_SWEEP_MS`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
