# API Versioning

Bunest supports all four NestJS v12 API versioning strategies—**URI**, **Header**, **Media Type**, and **Custom**—compiled directly into the route table at bootstrap so version dispatch adds zero reflection overhead per request.

## Enabling Versioning

Call `app.enableVersioning(...)` before `app.listen()`:

@@filename(main.ts)

```ts
import { BunestFactory, VersioningType } from "@bunest/core";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);

app.enableVersioning({
  type: VersioningType.URI,
  defaultVersion: "1",
});

await app.listen(3000);
```

## Versioning Strategies

| Strategy | Enum | Request Example | Configuration |
| --- | --- | --- | --- |
| **URI** | `VersioningType.URI` | `GET /v1/users`, `GET /v2/users` | `{ type: VersioningType.URI, prefix: "v" }` |
| **Header** | `VersioningType.HEADER` | `X-API-Version: 2` | `{ type: VersioningType.HEADER, header: "X-API-Version" }` |
| **Media Type** | `VersioningType.MEDIA_TYPE` | `Accept: application/json;v=2` | `{ type: VersioningType.MEDIA_TYPE, key: "v=" }` |
| **Custom** | `VersioningType.CUSTOM` | Any header, cookie, subdomain, or query | `{ type: VersioningType.CUSTOM, extractor: (req) => ... }` |

### Custom Extractor Example

@@filename(main.ts)

```ts
app.enableVersioning({
  type: VersioningType.CUSTOM,
  extractor: (request) => {
    const url = new URL(request.url);
    return url.searchParams.get("api-version") ?? "1";
  },
});
```

## Controller & Route-Level Versions

Apply `@Controller({ path, version })` for an entire controller, or `@Version()` on individual handlers to evolve specific endpoints without duplicating the whole controller:

@@filename(users.controller.ts)

```ts
import { Controller, Get, Version, VERSION_NEUTRAL } from "@bunest/core";

@Controller({ path: "users", version: "1" })
export class UsersController {
  @Get()
  findAllV1() {
    return [{ id: 1, name: "Ada" }];
  }

  // Overrides controller version: responds to /v2/users
  @Version("2")
  @Get()
  findAllV2() {
    return {
      data: [{ id: 1, fullName: "Ada Lovelace" }],
      meta: { total: 1 },
    };
  }

  // Serves both /v1/users/profile and /v2/users/profile
  @Version(["1", "2"])
  @Get("profile")
  getProfile() {
    return { active: true };
  }

  // Accessible regardless of version (e.g. /users/health)
  @Version(VERSION_NEUTRAL)
  @Get("health")
  health() {
    return { ok: true };
  }
}
```

## Duplicate Route Protection

Bunest's fail-fast router validates versioned routes at startup (`BUNEST_E101`). Two handlers with the same HTTP method and path are **allowed** when their versions differ (e.g., `@Version("1")` vs `@Version("2")`), and rejected immediately if two handlers claim the same version.

## OpenAPI & Swagger Integration

[`@bunest/swagger`](/apis/openapi) supports full multi-version OpenAPI 3.1 generation across all four versioning strategies:

@@filename(main.ts)

```ts
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";

const config = new DocumentBuilder()
  .setTitle("Users API")
  .setVersion("1.0")
  .build();

// Auto-discovers versions (via SwaggerModule.discoverApiVersions(app))
const docs = SwaggerModule.createVersionedDocuments(app, config, {
  includeVersionNeutral: true,
});

SwaggerModule.setup("docs", app, docs, {
  defaultVersion: "2",
});
```

- **Generated endpoints**: serves `/docs/v1-json`, `/docs/v1-yaml`, `/docs/v2-json`, `/docs/v2-yaml`, plus `/docs-json` and `/docs-yaml` for the configured `defaultVersion` (or latest version). All docs routes are registered as `VERSION_NEUTRAL`.
- **Version switcher**: automatically enabled in all three UI presets (`builtin`, `swagger-ui`, and `scalar`).
- **Single-version filtering & schema scoping**: call `SwaggerModule.createDocument(app, config, { version: "1", includeVersionNeutral: true })` to build one version's spec with `components.schemas` scoped strictly to DTOs used by that version.
- **All 4 strategies**: `URI` emits versioned paths; `HEADER` and `MEDIA_TYPE` inject scoped version header parameters (`required: false` when `VERSION_NEUTRAL` or matching `defaultVersion`); `CUSTOM` accepts `customVersionParameter` (`query`, `header`, or `cookie`).

> warning **Header, Media Type & Custom Modes** Because different versions share the same OpenAPI path and method (e.g. `GET /users`) in `HEADER`, `MEDIA_TYPE`, and `CUSTOM` modes, generating a single unfiltered document causes later versions to overwrite earlier ones. Use `SwaggerModule.createVersionedDocuments()` or `createDocument(..., { version })` to avoid collisions.

> info **Full OpenAPI Reference** See the [`@bunest/swagger`](/apis/openapi) guide for `discoverApiVersions()`, `infoVersionResolver`, `customVersionParameter`, and UI preset options.
