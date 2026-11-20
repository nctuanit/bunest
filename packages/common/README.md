# @bunest/common

Shared decorators, metadata registry, HTTP exceptions, built-in pipes, logger, lifecycle interfaces, and configurable module builder for Bunest.

## Features

- **Core & HTTP Decorators**: `@Module()`, `@Global()`, `@Injectable()`, `@Inject()`, `@Optional()`, `@Controller()`, `@Get()`, `@Post()`, `@Put()`, `@Patch()`, `@Delete()`, `@All()`, `@Body()`, `@Param()`, `@Query()`, `@Headers()`, `@Cookies()`, `@Ip()`, `@HttpCode()`, `@Header()`, `@UseGuards()`, `@UseInterceptors()`, `@UsePipes()`, `@UseFilters()`, and `applyDecorators()`.
- **HTTP Exception Hierarchy**: `HttpException`, `IntrinsicException`, and all standard HTTP exceptions (`BadRequestException`, `UnauthorizedException`, `ForbiddenException`, `NotFoundException`, `ConflictException`, `UnprocessableEntityException`, `TooManyRequestsException`, `InternalServerErrorException`, etc.).
- **Pipes, Serialization & Validation**: `DefaultValuePipe`, `ParseIntPipe`, `ParseBoolPipe`, `ParseUUIDPipe`, `ParseArrayPipe`, `ParseEnumPipe`, `ClassSerializerInterceptor`, `FileValidator`, `FileTypeValidator`, and Standard Schema v1 (`isStandardSchema`) support.
- **Metadata & Module Utilities**: `Reflector`, `MetadataRegistry`, `DecoratorRegistry`, `ConfigurableModuleBuilder`, `forwardRef()`, and mapped type helpers.
- **Logging**: Structured `ConsoleLogger` with log-level filtering and secret redaction defaults (`DEFAULT_REDACT_KEYS`).

## Installation

```bash
bun add @bunest/common reflect-metadata
```

## Quick Start

```ts
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from "@bunest/common";

@Injectable()
export class ItemsService {
  private readonly items = new Map<string, { id: string; name: string }>();

  create(name: string) {
    const id = crypto.randomUUID();
    const item = { id, name };
    this.items.set(id, item);
    return item;
  }

  findOne(id: string) {
    const item = this.items.get(id);
    if (!item) throw new NotFoundException(`Item ${id} not found`);
    return item;
  }
}

@Controller("items")
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Post()
  create(@Body() body: { name: string }) {
    return this.items.create(body.name);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.items.findOne(id);
  }
}

@Module({
  controllers: [ItemsController],
  providers: [ItemsService],
})
export class ItemsModule {}
```

## Key Exports

- **Decorators**: `@Module()`, `@AutoModule()`, `@Global()`, `@Injectable()`, `@Inject()`, `@Optional()`, `@Catch()`, `@SetMetadata()`, `@Controller()`, `@Get()`, `@Post()`, `@Put()`, `@Patch()`, `@Delete()`, `@Head()`, `@All()`, `@Body()`, `@Param()`, `@Query()`, `@Headers()`, `@Cookies()`, `@Ip()`, `@HostParam()`, `@HttpCode()`, `@Header()`, `applyDecorators()`
- **Exceptions**: `HttpException`, `IntrinsicException`, `BadRequestException`, `UnauthorizedException`, `ForbiddenException`, `NotFoundException`, `MethodNotAllowedException`, `ConflictException`, `GoneException`, `UnprocessableEntityException`, `TooManyRequestsException`, `InternalServerErrorException`, `NotImplementedException`, `BadGatewayException`, `ServiceUnavailableException`, `GatewayTimeoutException`
- **Metadata & DI**: `Reflector`, `MetadataRegistry`, `DecoratorRegistry`, `ConfigurableModuleBuilder`, `forwardRef`, `isDynamicModule`, `APP_GUARD`, `APP_INTERCEPTOR`, `APP_PIPE`, `APP_FILTER`, `REQUEST`, `REQUEST_CONTEXT`, `INQUIRER`
- **Enums & Pipes**: `HttpStatus`, `RequestMethod`, `Scope`, `ShutdownSignal`, `VersioningType`, `VERSION_NEUTRAL`, `DefaultValuePipe`, `ClassSerializerInterceptor`, `FileValidator`, `FileTypeValidator`, `ConsoleLogger`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
