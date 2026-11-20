# Controllers

Controllers are responsible for handling incoming **HTTP requests** and returning **responses** to the client. Following NestJS conventions ([ADR-003](/architecture/adrs), [RFC-001](/architecture/adrs)), each `@Controller()` class groups related endpoints as decorated methods—no `BaseMethod` inheritance or class-per-endpoint boilerplate is required.

## Routing

Apply the `@Controller()` class decorator to define an optional route prefix, and attach HTTP verb decorators (`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`, `@Head`, `@All`, `@Sse`) to handler methods:

@@filename(cats.controller.ts)
```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@bunest/core";
import { CreateCatDto } from "./dto/create-cat.dto";
import { UpdateCatDto } from "./dto/update-cat.dto";

@Controller("cats")
export class CatsController {
  @Get()
  findAll(@Query("breed") breed?: string) {
    return { action: "findAll", breed: breed ?? null };
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return { action: "findOne", id };
  }

  @Post()
  create(@Body() dto: CreateCatDto) {
    // POST automatically returns 201 Created (ADR-010)
    return { created: true, data: dto };
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateCatDto) {
    return { updated: true, id, data: dto };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param("id") id: string) {
    // 204 No Content enforces an empty body per RFC 9110
  }
}
```

> info **Hint** Register every controller in a module's `@Module({ controllers: [CatsController] })` array. Undecorated classes listed in `controllers` fail fast at bootstrap with `InvalidControllerException`.

## Multiple Prefixes & Host Constraints

`@Controller()` accepts a string, an array of route prefixes, or a full `ControllerOptions` object:

@@filename(versioned.controller.ts)
```ts
import { Controller, Get, HostParam, Scope } from "@bunest/core";

// Mount identical routes under both /v1/users and /v2/users
@Controller(["/v1/users", "/v2/users"])
export class VersionedUsersController {
  @Get()
  list() {
    return [];
  }
}

// Host-constrained controller (dispatched via Fallback Radix Router — ADR-011)
@Controller({
  path: "accounts",
  host: ":tenant.example.com",
  scope: Scope.SINGLETON,
})
export class TenantAccountsController {
  @Get()
  getTenant(@HostParam("tenant") tenant: string) {
    return { tenant };
  }
}
```

## Request Parameter Decorators

Bunest provides NestJS-compatible legacy parameter decorators indexed by parameter position ([ADR-004](/architecture/adrs)). Parameters can appear in **any order**, and Bunest never parses function source strings.

| Decorator | Extracts | Notes |
|---|---|---|
| `@Body(key?, ...pipes)` | Parsed request body or `body[key]` | Lazily parsed and cached once per request |
| `@Query(key?, ...pipes)` | Query string record or single/array value | Always arrives as `string` / `string[]` |
| `@Param(key?, ...pipes)` | Route parameters object or `params[key]` | URL-decoded natively by Bun |
| `@Headers(key?, ...pipes)` | Lowercased header map or specific header | Case-insensitive lookup |
| `@Cookies(key?, ...pipes)` | Parsed cookies via Bun native `CookieMap` | Falls back to `Cookie` header |
| `@Req()` | Native Web `Request` | Includes matched `params` |
| `@Res()` | Mutable `ResponseContext` builder | Set status, headers, cookies while still returning body |
| `@Ip()` | Client IP via `server.requestIP(req)` | Respects configured `trustProxy` policy |
| `@HostParam(key?, ...pipes)` | Matched host parameter(s) | For host-constrained controllers |
| `@UploadedFile(field?, ...pipes)` | Single `UploadedFileInfo` | Parsed from `multipart/form-data` |
| `@UploadedFiles(field?, ...pipes)` | `UploadedFileInfo[]` | Parsed from `multipart/form-data` |

> tip **Single-Read Body Cache** Web `Request.body` is a single-use stream. Bunest caches parsed body data per `RequestContext`, so extracting `@Body("email")` and `@Body("name")` in the same handler never throws `Body already used`.

## Status Codes, Headers & Redirects

By default, **`POST` returns `201 Created`** and all other HTTP verbs return **`200 OK`** ([ADR-010](/architecture/adrs)). Override status codes, static headers, or redirects declaratively:

@@filename(response-meta.controller.ts)
```ts
import { Controller, Get, Header, HttpCode, Post, Redirect, Res } from "@bunest/core";
import type { ResponseContext } from "@bunest/core";

@Controller("downloads")
export class DownloadsController {
  @Post("trigger")
  @HttpCode(202)
  @Header("X-Powered-By", "Bunest")
  @Header("Cache-Control", "no-store")
  triggerJob() {
    return { status: "queued" };
  }

  @Get("docs")
  @Redirect("https://bun.sh/docs", 302)
  redirectToDocs() {
    // Return { url, statusCode } dynamically to override decorator args
    return { url: "https://bun.sh/docs/api/http", statusCode: 301 };
  }

  @Get("custom")
  customResponse(@Res() res: ResponseContext) {
    res.status(200).header("X-Request-Mode", "builder").cookie("seen", "1", {
      httpOnly: true,
      sameSite: "lax",
    });
    return { ok: true };
  }
}
```

## Native `Response` Passthrough

Because Bun runs natively on Web Standards, any handler can directly return a `new Response(...)`, `Bun.file(...)`, or `ReadableStream`:

@@filename(raw.controller.ts)
```ts
import { Controller, Get } from "@bunest/core";

@Controller("raw")
export class RawController {
  @Get("health")
  health(): Response {
    return new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
```

## Path Normalization & Fail-Fast Collisions

At bootstrap, Bunest joins `[globalPrefix, controllerPrefix, methodPath]`, collapses repeated slashes, strips trailing slashes on non-root routes, and canonicalizes parameter names (`:id` -> `:_`).

> warning **Duplicate Route Detection** Registering both `GET /users/:id` and `GET /users/:userId` canonicalizes to the same key `GET /users/:_` and throws **`DuplicateRouteException`** before `Bun.serve()` starts listening.

## Stateless Singleton Rule & Inheritance

- Controllers default to **`Scope.SINGLETON`**—never store per-request mutable state on `this`. Opt into `Scope.REQUEST` only when necessary (see [Injection scopes](/fundamentals/injection-scopes)).
- Subclassing a controller safely inherits parent routes via copy-on-write metadata—decorating a subclass never mutates the base controller's route registry ([ADR-002](/architecture/adrs)).
