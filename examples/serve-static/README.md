# Serve Static & SPA (`24-serve-static`)

Bunest counterpart of NestJS's [`sample/24-serve-static`](https://github.com/nestjs/nest/tree/master/sample/24-serve-static):

- **`ServeStaticModule.forRoot()`**: Serves `client/` static assets natively via `Bun.file()` with ETag/304, dotfiles protection, and SPA fallback
- **API Prefix Coexistence**: REST endpoints mounted under `/api/*` (`GET /api/info`, `GET /api/download` returning `StreamableFile`) excluded from static fallback

## Run

```bash
bun run --cwd examples/serve-static dev
bun run --cwd examples/serve-static test
```
