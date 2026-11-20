# RFC-001: NestJS-Style Controller Routing & Compile-at-Bootstrap Execution

- **Status:** Accepted
- **Date:** 2026-11-20
- **Author:** Bunest Architecture Team
- **Target Packages:** `@bunest/common`, `@bunest/core`, `@bunest/http`, `@bunest/validation`
- **Related ADRs:** [ADR-002](../adr/ADR-002.md), [ADR-003](../adr/ADR-003.md), [ADR-004](../adr/ADR-004.md), [ADR-006](../adr/ADR-006.md), [ADR-008](../adr/ADR-008.md), [ADR-011](../adr/ADR-011.md)

---

## 1. Summary

This RFC locks down Bunest's public HTTP routing syntax, path normalization, parameter index metadata, and compile-at-bootstrap execution model:

```ts
import "reflect-metadata";
import { Body, Controller, Get, Param, Post, Query } from "@bunest/core";
import { CreateUserDto } from "./create-user.dto";
import { UsersService } from "./users.service";

@Controller("/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.users.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateUserDto, @Query("notify") notify?: string) {
    return this.users.create(dto);
  }
}
```

Routing uses **one controller class per resource with multiple HTTP-decorated methods** (NestJS DX), compiled once at bootstrap into native `Bun.serve()` handlers with **zero per-request reflection**.

---

## 2. Public Routing Syntax

| Element | Decorator | Semantics |
|---|---|---|
| Controller class | `@Controller(prefix \| options)` | Marks a class as an HTTP controller with optional route prefix (`string \| string[]`), `host`, and DI `scope`. |
| Route methods | `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`, `@Head`, `@All`, `@Sse` | Method decorators binding an HTTP verb + relative path (`""` default) to a controller method. |
| Parameter binding | `@Body`, `@Query`, `@Param`, `@Headers`, `@Req`, `@Res`, `@Ip`, `@HostParam`, `@Cookies`, `@UploadedFile`, `@UploadedFiles`, `createParamDecorator` | Legacy parameter decorators recording source, optional key, pipes, and parameter index. |
| Response metadata | `@HttpCode(code)`, `@Header(name, value)`, `@Redirect(url?, code?)` | Declares static status code, response headers, or redirect target. |
| Enhancers | `@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters` | Attaches pipeline enhancers at controller or method scope. |

- **Rejected APIs:** Class-per-endpoint inheritance (`BaseMethod`, `PostMethod`) and `static parameters = [...]` are NOT part of the public routing API.
- **Controller registration:** Controllers MUST be listed in `@Module({ controllers: [...] })` AND decorated with `@Controller()`. Undecorated classes in `controllers` fail fast at bootstrap.
- **Default status codes:** `POST` returns `201 Created`; all other methods return `200 OK`; `@Redirect()` defaults to `302 Found`; `@HttpCode()` overrides defaults (see [ADR-010](../adr/ADR-010.md)).

---

## 3. Path Normalization & Collision Rules

Full route path is composed from `[globalPrefix, controllerPrefix, methodPath]`:

1. For each non-empty segment, trim leading and trailing `/`, and collapse consecutive `/` into a single `/`.
2. Join remaining non-empty segments with `/` and prepend a leading `/`. If all segments are empty, the normalized path is `"/"`.
3. Non-root paths never end with a trailing `/` (e.g., `"/users/"` + `"/:id/"` -> `"/users/:id"`).
4. **Canonical collision key:** Replace every named parameter segment (`:name`) with a positional wildcard placeholder (`:_`). Two routes collide if they share `(httpMethod, canonicalPath, host)` (where `@All()` collides with any specific verb on the same canonical path + host).
   - Example: `GET /users/:id` and `GET /users/:userId` both canonicalize to `GET /users/:_` -> **bootstrap error** (`DuplicateRouteException`).
5. **Fail-fast:** All collisions MUST throw before `Bun.serve()` binds a listening socket.

---

## 4. Parameter Index Metadata & Inheritance Safety

- Decorators store metadata via `@bunest/common`'s `MetadataRegistry` using namespaced `Symbol` keys (never mutating parent prototype metadata on subclassing — copy-on-write on subclass targets).
- Each parameter decorator writes a `ParameterMetadata` entry keyed by `parameterIndex` on `(controllerPrototype, handlerKey)`:
  ```ts
  interface ParameterMetadata {
    index: number;
    source: ParameterSource;
    key?: string;
    metatype?: Function;
    pipes?: readonly (Type<PipeTransform> | PipeTransform)[];
    factory?: CustomParamFactory;
    data?: unknown;
  }
  ```
- **Index-driven binding:** Bunest NEVER parses JavaScript source parameter names. At bootstrap, parameter metadata is combined with `Reflect.getMetadata("design:paramtypes", prototype, handlerKey)` (emitted by `experimentalDecorators: true` + `emitDecoratorMetadata: true`; keep `verbatimModuleSyntax: true`, value-import DI/DTO classes, and `import type` interfaces/types per [ADR-002](../adr/ADR-002.md)) and sorted ascending by `index`.
- **Invariants:**
  - Out-of-order and sparse parameter decorators are allowed; undecorated parameter slots receive `undefined`.
  - Multiple parameter decorators on the same `(handlerKey, index)` MUST fail fast at bootstrap (unless explicitly composed via `createParamDecorator`).
  - Request body parsing (`@Body`) is cached once per `RequestContext` so multiple `@Body("a")` / `@Body("b")` parameters never consume the `Request` stream twice.

---

## 5. Compile-at-Bootstrap Execution Model

```text
Bootstrap (runs once)                     Hot Path (per request — zero Reflect calls)
─────────────────────                     ───────────────────────────────────────────
1. Scan @Module graph & resolve DI        1. Bun.serve({ routes }) O(1)/radix match
2. Discover @Controller methods           2. Enter compiled route closure
3. Normalize paths & detect collisions    3. Create RequestContext (+ ALS if scoped)
4. Merge design:paramtypes + param meta   4. CORS -> Middleware -> Guards
5. Resolve global/ctrl/method enhancers   5. Interceptors(before) -> Param Extract -> Pipes
6. Pre-compile per-route ExecutionPlan    6. Invoke controller[handlerKey](...args)
7. Register in Bun.serve({ routes })      7. Interceptors(after) -> Serialize Response
   + Fallback Router (405/404/advanced)      (Exception Filters wrap stages 3–7)
```

- **Pure singleton fast path:** If a route's controller and enhancers are all `Scope.SINGLETON`, every instance and enhancer chain is bound into the route closure at bootstrap—zero DI lookups and zero `Reflect.getMetadata()` calls occur per request.
- **Request-scoped opt-in:** Only routes explicitly marked `Scope.REQUEST` create a per-request DI container (see [ADR-012](../adr/ADR-012.md)).

---

## 6. Acceptance Criteria

1. `POST /users` with `@Controller("/users")`, `@Post()`, `@Body() dto: CreateUserDto`, constructor DI, and `ValidationPipe` returns `201` with validated DTO data and `400` on invalid payload.
2. Subclassing a controller inherits parent routes without mutating the parent's route or parameter metadata.
3. Out-of-order parameter decorators (`@Query`, `@Body`, `@Param`) inject arguments at exact parameter indices.
4. Duplicate routes (including renamed params `/users/:id` vs `/users/:userId`) fail fast before listening.
5. Hot-path execution performs zero `Reflect.getMetadata()` calls per request.
