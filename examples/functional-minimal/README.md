# Zero-Boilerplate Functional Microservice (`functional-minimal`)

Solves NestJS's **"too much boilerplate for small microservices"** complaint — Hono/Elysia-style ergonomics with full Bunest DI, Standard Schema validation, and OpenAPI 3.1:

- **Zero `@Module` / `@Controller` ceremony**: Boots directly via `BunestFactory.createRoutes(shortenerRoutes, { providers: [ShortenerService] })`
- **Inline Standard Schema (`s.*`)**: Validates `bodySchema`, `paramsSchema`, and `responseSchema` with automatic TypeScript inference
- **Automatic Swagger 3.1**: Clean tags, summaries, and JSON schemas generated without decorators

## Run

```bash
bun run --cwd examples/functional-minimal dev
bun run --cwd examples/functional-minimal test
```
