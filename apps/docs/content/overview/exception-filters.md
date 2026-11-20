# Exception filters

Bunest includes a centralized exception handling layer that catches every unhandled exception thrown across stages 3–11 of the [11-Stage Execution Pipeline](/architecture/execution-pipeline) as well as fallback `404` and `405` errors, turning them into consistent, safe JSON responses.

## Throwing Standard Exceptions

`@bunest/common` (re-exported by `@bunest/core`) provides `HttpException` and 16 ready-to-use HTTP exception subclasses:

@@filename(users.controller.ts)
```ts
import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
} from "@bunest/core";

@Controller("users")
export class UsersController {
  @Get(":id")
  findOne(@Param("id") id: string) {
    if (id === "0") {
      throw new NotFoundException(`User #${id} does not exist`);
    }
    if (id === "admin") {
      throw new ForbiddenException("Admin profile is restricted");
    }
    if (id === "teapot") {
      throw new HttpException("I'm a teapot", HttpStatus.I_AM_A_TEAPOT);
    }
    return { id };
  }
}
```

### Built-in HTTP Exceptions

| Exception Class | Status | Default Reason Phrase |
|---|---|---|
| `BadRequestException` | `400` | Bad Request |
| `UnauthorizedException` | `401` | Unauthorized |
| `ForbiddenException` | `403` | Forbidden |
| `NotFoundException` | `404` | Not Found |
| `MethodNotAllowedException` | `405` | Method Not Allowed |
| `ConflictException` | `409` | Conflict |
| `GoneException` | `410` | Gone |
| `PayloadTooLargeException` | `413` | Payload Too Large |
| `UnsupportedMediaTypeException` | `415` | Unsupported Media Type |
| `UnprocessableEntityException` | `422` | Unprocessable Entity |
| `TooManyRequestsException` | `429` | Too Many Requests |
| `InternalServerErrorException` | `500` | Internal Server Error |
| `NotImplementedException` | `501` | Not Implemented |
| `BadGatewayException` | `502` | Bad Gateway |
| `ServiceUnavailableException` | `503` | Service Unavailable |
| `GatewayTimeoutException` | `504` | Gateway Timeout |

## Normalized Error Envelope

All Bunest exceptions share a uniform JSON response structure ([ADR-009](/architecture/adrs)):

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "User #0 does not exist",
  "timestamp": "2026-11-20T03:00:00.000Z",
  "path": "/users/0"
}
```

> warning **Production Safety Invariant** For unknown or non-`HttpException` errors, the built-in `DefaultExceptionFilter` logs the failure internally via `Logger` and responds with `500 Internal Server Error` (`"Internal server error"`). It **never leaks stack traces or internal messages** when `NODE_ENV === "production"`, and always preserves configured CORS headers.

## Custom Exception Filters (`@Catch`)

Create a custom filter by implementing `ExceptionFilter` and decorating it with `@Catch(...exceptionTypes)`. Returning a native Web `Response` (or using `ResponseContext`) handles the error cleanly:

@@filename(http-exception.filter.ts)
```ts
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@bunest/core";

@Catch(HttpException)
export class CustomHttpExceptionFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost): Response {
    const http = host.switchToHttp();
    const req = http.getRequest();
    const status = exception.getStatus();

    return Response.json(
      {
        statusCode: status,
        message: exception.message,
        path: new URL(req.url).pathname,
        timestamp: new Date().toISOString(),
      },
      { status },
    );
  }
}
```

> info **Catch-All Filter** Decorate a class with empty `@Catch()` to handle **any** thrown value at that scope level.

## Binding Filters & Precedence

Attach filters at method, controller, or global scope—either via `@UseFilters(...)` or DI-aware `APP_FILTER`:

@@filename(binding-filters.ts)
@@tab(Controller / Method)
```ts
import { Controller, Get, UseFilters } from "@bunest/core";
import { CustomHttpExceptionFilter } from "./http-exception.filter";

@UseFilters(CustomHttpExceptionFilter)
@Controller("orders")
export class OrdersController {
  @Get(":id")
  findOne() {
    // Covered by CustomHttpExceptionFilter
  }
}
```
@@switch
@@tab(Global DI Token)
```ts
import { APP_FILTER, Module } from "@bunest/core";
import { CustomHttpExceptionFilter } from "./http-exception.filter";

@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: CustomHttpExceptionFilter,
    },
  ],
})
export class AppModule {}
```

Unlike middleware, guards, and pipes, **Exception Filters run most-specific first**:

```text
Method (@UseFilters) -> Controller (@UseFilters) -> Global (APP_FILTER / useGlobalFilters) -> DefaultExceptionFilter
```

The first matching filter whose `@Catch(...)` matches `error instanceof ExceptionType` handles the error.
