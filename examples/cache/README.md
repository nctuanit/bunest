# Caching (`20-cache`)

Bunest counterpart of NestJS's [`sample/20-cache`](https://github.com/nestjs/nest/tree/master/sample/20-cache), built on `@bunest/cache`:

- **HTTP Response Caching**: `@UseInterceptors(CacheInterceptor)` with `@CacheKey()`, `@CacheTTL()`, and `@NoCache()`
- **Service-Level AOP Caching**: `@Cacheable()`, `@CachePut()`, and `@CacheEvict()` with tag-based invalidation and single-flight stampede protection
- **Imperative Cache Access**: `@Inject(CACHE_MANAGER)` / `CacheService`

## Run

```bash
bun run --cwd examples/cache dev
bun run --cwd examples/cache test
```
