# Response Serialization Contract

**[ADR-010](/architecture/adrs)** locks down Bunest's return-value serialization matrix, default HTTP status codes, RFC 9110 empty-body rules, and header merge precedence across every handler return type.

## Status Code Resolution Precedence

Evaluated from highest to lowest priority:

1. Returned native **`Response.status`** (when handler/interceptor returns `value instanceof Response`).
2. Status set dynamically via **`@Res()`** (`ResponseContext.status(code)`).
3. Dynamic redirect status returned from a **`@Redirect()`** handler (`{ url, statusCode }`).
4. **`@HttpCode(code)`** decorator on the handler method.
5. **`@Redirect(url, statusCode)`** decorator default (`302 Found`).
6. HTTP method default:
   - **`POST` &rarr; `201 Created`**
   - **`GET`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD` &rarr; `200 OK`**

## Return Value Serialization Matrix

Evaluated in strict top-to-bottom priority after all interceptors unwind:

| Priority | Returned Value Type                                 | HTTP Body                    | Default `Content-Type`                      | Notes                                                                                          |
| -------- | --------------------------------------------------- | ---------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1        | `value instanceof Response`                         | **Passthrough** (unmodified) | Preserved from `Response`                   | Merges CORS, `Set-Cookie`, and missing `@Header()` headers without clobbering explicit headers |
| 2        | `@Redirect()` route                                 | Empty (`null`)               | None                                        | Sets `Location` header from dynamic return or decorator URL                                    |
| 3        | `@Sse()` route (`AsyncIterable` / `ReadableStream`) | SSE UTF-8 stream             | `text/event-stream; charset=utf-8`          | Sets `Cache-Control: no-cache, no-transform`; cancels iterator on abort                        |
| 4        | `value instanceof ReadableStream`                   | Streamed directly            | `application/octet-stream`                  | Zero-buffering native Web stream passthrough                                                   |
| 5        | `value instanceof Blob` (incl. `Bun.file()`)        | `new Response(blob)`         | `blob.type \|\| "application/octet-stream"` | Preserves Bun's zero-copy `sendfile` optimization                                              |
| 6        | `Uint8Array` / `ArrayBuffer` / `ArrayBufferView`    | Raw binary bytes             | `application/octet-stream`                  | Direct binary response without JSON encoding                                                   |
| 7        | `null` or `undefined`                               | Empty (`null`)               | None                                        | Returns `new Response(null, { status, headers })`                                              |
| 8        | `string`                                            | UTF-8 text                   | `text/plain; charset=utf-8`                 | Override via `@Header("Content-Type", "text/html; charset=utf-8")`                             |
| 9        | `number` or `boolean`                               | `JSON.stringify(value)`      | `application/json; charset=utf-8`           | Valid JSON primitive round-trippable with `res.json()`                                         |
| 10       | Plain object / Array / Class instance               | `JSON.stringify(value)`      | `application/json; charset=utf-8`           | Respects `toJSON()`; circular structures throw `500` caught by Exception Filters               |

## RFC 9110 Empty-Body Enforcement

For responses with status **`204 No Content`**, **`304 Not Modified`**, **`1xx`**, or requests with HTTP method **`HEAD`**, Bunest always constructs `new Response(null, { status, headers })` with an empty body regardless of what the handler returned.

## Header & `Set-Cookie` Merge Order

Headers merge in increasing priority (later layers override single-value headers):

1. Serializer default `Content-Type`
2. Configured CORS headers
3. Static `@Header(name, value)` entries (in declaration order)
4. Dynamic headers from `@Res()` (`ResponseContext.header(...)`)
5. Explicit headers already present on a returned native `Response`

`Set-Cookie` entries are **always appended** (`headers.append("Set-Cookie", ...)`) so multiple cookies never overwrite one another.
