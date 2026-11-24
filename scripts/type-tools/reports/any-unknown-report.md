# Bunest `any` & `unknown` AST Audit Report

Generated at: 2026-11-22T12:35:02.178Z
Scanned files: **2493**

## 1. Executive Summary

| Metric | `any` | `unknown` | Total |
| --- | ---: | ---: | ---: |
| **All scanned files** | 2507 | 9945 | 12452 |
| **Production (`packages/*/src`)** | 1431 | 7175 | 8606 |
| **Public API signatures (`packages/*/src`)** | 1046 | 3283 | 4329 |
| **Internal impl (`packages/*/src`)** | 385 | 3892 | 4277 |

## 2. Breakdown by Scope

| Scope | Files w/ hits | `any` | `unknown` | Total |
| --- | ---: | ---: | ---: | ---: |
| `package-src` | 760 | 1431 | 7175 | 8606 |
| `root-test` | 388 | 707 | 1954 | 2661 |
| `package-test` | 145 | 369 | 802 | 1171 |
| `examples` | 4 | 0 | 7 | 7 |
| `benchmarks` | 3 | 0 | 6 | 6 |
| `apps` | 1 | 0 | 1 | 1 |

## 3. Production (`packages/*/src`) by Pattern

| Pattern | `any` (Public) | `unknown` (Public) | Total | Sample |
| --- | ---: | ---: | ---: | --- |
| `record-string-unknown` | 0 (0) | 1600 (653) | 1600 | `packages/microservices/src/client-interfaces.ts:19` → `Record<string, unknown>` |
| `other` | 394 (208) | 809 (295) | 1203 | `packages/microservices/src/client-interfaces.ts:18` → `ClientProxy<any, any>` |
| `untyped-parameter` | 22 (16) | 1085 (462) | 1107 | `packages/microservices/src/client-interfaces.ts:72` → `pattern: unknown` |
| `variadic-constructor-or-fn` | 411 (347) | 660 (356) | 1071 | `packages/microservices/src/client-interfaces.ts:48` → `...args: any[]` |
| `untyped-property` | 7 (7) | 587 (235) | 594 | `packages/microservices/src/client-proxy.ts:48` → `data: unknown;` |
| `generic-default-unknown` | 0 (0) | 476 (425) | 476 | `packages/microservices/src/client-proxy.ts:129` → `T = unknown` |
| `array-any-or-unknown` | 46 (40) | 406 (149) | 452 | `packages/microservices/src/ctx-host.ts:7` → `unknown[]` |
| `error-or-catch` | 2 (2) | 398 (184) | 400 | `packages/microservices/src/exceptions.ts:315` → `exception: unknown` |
| `untyped-return` | 38 (33) | 361 (236) | 399 | `packages/microservices/src/helpers.ts:21` → `loadSync(path: string \| string[], loader?: Record<string, u` |
| `generic-default-any` | 394 (310) | 0 (0) | 394 | `packages/microservices/src/client-proxy.ts:136` → `TRes = any` |
| `map-set-promise-container` | 12 (11) | 220 (117) | 232 | `packages/microservices/src/client-proxy.ts:133` → `Promise<any>` |
| `double-cast` | 0 (0) | 213 (3) | 213 | `packages/microservices/src/client-proxy.ts:60` → `this.currentStatus as unknown as Status` |
| `index-signature` | 4 (4) | 102 (95) | 106 | `packages/microservices/src/helpers.ts:11` → `[key: string]: unknown;` |
| `decorator-or-reflect` | 8 (3) | 95 (56) | 103 | `packages/bull/src/bull-metadata.accessor.ts:15` → `Type<unknown>` |
| `untyped-variable` | 0 (0) | 102 (0) | 102 | `packages/microservices/src/client-proxy.ts:188` → `lastError: unknown` |
| `conditional-type-check` | 23 (20) | 53 (17) | 76 | `packages/swagger/src/interfaces/openapi.interface.ts:814` → `ReadonlyArray<unknown>` |
| `record-string-any` | 64 (39) | 0 (0) | 64 | `packages/microservices/src/ctx-host.ts:200` → `Record<string, any>` |
| `cast-to-unknown` | 0 (0) | 8 (0) | 8 | `packages/locks/src/services/leader-elections.service.ts:25` → `wrapper.isDependencyTreeStatic as unknown` |
| `cast-to-any` | 6 (6) | 0 (0) | 6 | `packages/authorization/src/authorization.constants.ts:14` → `Symbol.for( "@nestjs/authorization:guard", ) as any` |

## 4. Production (`packages/*/src`) by AST Kind

| AST Kind | `any` | `unknown` | Public API | Total |
| --- | ---: | ---: | ---: | ---: |
| `record-value` | 64 | 1599 | 691 | 1663 |
| `parameter` | 22 | 1305 | 557 | 1327 |
| `generic-arg` | 377 | 867 | 550 | 1244 |
| `function-type` | 331 | 644 | 649 | 975 |
| `generic-default` | 394 | 476 | 735 | 870 |
| `property` | 7 | 651 | 282 | 658 |
| `array-element` | 46 | 407 | 189 | 453 |
| `return-type` | 41 | 373 | 280 | 414 |
| `double-cast` | 0 | 213 | 3 | 213 |
| `other` | 21 | 166 | 62 | 187 |
| `rest-args` | 40 | 124 | 92 | 164 |
| `variable` | 0 | 108 | 0 | 108 |
| `index-signature` | 4 | 102 | 99 | 106 |
| `union-or-intersection` | 14 | 63 | 67 | 77 |
| `conditional-extends` | 23 | 53 | 37 | 76 |
| `constructor-type` | 41 | 12 | 30 | 53 |
| `type-assertion` | 6 | 8 | 6 | 14 |
| `catch-clause` | 0 | 4 | 0 | 4 |

## 5. Breakdown by Package

| Package | src `any` | src `unknown` | Public API (`any`/`unknown`) | test `any` | test `unknown` | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `@bunest/common` | 125 | 1114 | 116 / 470 | 24 | 76 | 1339 |
| `@bunest/mongoose` | 179 | 403 | 157 / 246 | 23 | 1 | 606 |
| `@bunest/core` | 51 | 507 | 37 / 209 | 22 | 40 | 620 |
| `@bunest/microservices` | 113 | 341 | 77 / 182 | 0 | 39 | 493 |
| `@bunest/store-kit` | 39 | 365 | 39 / 70 | 49 | 20 | 473 |
| `@bunest/graphql` | 133 | 267 | 82 / 139 | 3 | 16 | 419 |
| `@bunest/http` | 44 | 258 | 32 / 153 | 5 | 63 | 370 |
| `@bunest/queues` | 94 | 206 | 36 / 130 | 29 | 28 | 357 |
| `@bunest/workflows` | 21 | 239 | 16 / 129 | 0 | 64 | 324 |
| `@bunest/ai` | 37 | 220 | 24 / 112 | 13 | 11 | 281 |
| `@bunest/sql` | 28 | 180 | 22 / 84 | 14 | 52 | 274 |
| `@bunest/security` | 33 | 147 | 25 / 56 | 22 | 19 | 221 |
| `@bunest/cqrs` | 80 | 100 | 68 / 33 | 4 | 8 | 192 |
| `@bunest/elasticsearch` | 11 | 169 | 11 / 154 | 9 | 1 | 190 |
| `@bunest/swagger` | 14 | 164 | 6 / 66 | 0 | 14 | 192 |
| `@bunest/idempotency` | 17 | 160 | 4 / 43 | 18 | 17 | 212 |
| `@bunest/testing` | 18 | 156 | 9 / 84 | 5 | 14 | 193 |
| `@bunest/observability` | 31 | 134 | 28 / 52 | 11 | 7 | 183 |
| `@bunest/authentication` | 28 | 125 | 14 / 44 | 8 | 7 | 168 |
| `@bunest/websockets` | 20 | 133 | 15 / 60 | 0 | 10 | 163 |
| `@bunest/typeorm` | 8 | 145 | 8 / 91 | 7 | 1 | 161 |
| `@bunest/mcp` | 18 | 130 | 9 / 71 | 0 | 4 | 152 |
| `@bunest/apollo` | 11 | 123 | 9 / 46 | 14 | 0 | 148 |
| `@bunest/outbox` | 17 | 105 | 7 / 36 | 1 | 31 | 154 |
| `@bunest/config` | 39 | 83 | 26 / 23 | 0 | 11 | 133 |
| `@bunest/resilience` | 3 | 111 | 1 / 37 | 0 | 8 | 122 |
| `@bunest/sequelize` | 43 | 70 | 41 / 58 | 4 | 0 | 117 |
| `@bunest/sqlite` | 11 | 95 | 7 / 31 | 4 | 17 | 127 |
| `@bunest/observe` | 23 | 70 | 18 / 23 | 2 | 0 | 95 |
| `@bunest/authorization` | 16 | 73 | 11 / 20 | 0 | 4 | 93 |
| `@bunest/i18n` | 1 | 85 | 0 / 19 | 0 | 30 | 116 |
| `@bunest/bull` | 28 | 53 | 23 / 26 | 2 | 0 | 83 |
| `@bunest/webhooks` | 3 | 76 | 3 / 33 | 5 | 37 | 121 |
| `@bunest/mail` | 12 | 67 | 4 / 17 | 0 | 20 | 99 |
| `@bunest/validation` | 5 | 73 | 0 / 19 | 45 | 78 | 201 |
| `@bunest/cache` | 11 | 65 | 9 / 45 | 0 | 4 | 80 |
| `@bunest/storage` | 2 | 64 | 2 / 29 | 1 | 1 | 68 |
| `@bunest/axios` | 41 | 24 | 32 / 8 | 4 | 9 | 78 |
| `@bunest/http-client` | 0 | 65 | 0 / 34 | 0 | 3 | 68 |
| `@bunest/events` | 3 | 60 | 3 / 36 | 0 | 9 | 72 |
| `@bunest/locks` | 1 | 51 | 1 / 16 | 0 | 13 | 65 |
| `@bunest/drizzle` | 15 | 35 | 11 / 18 | 12 | 1 | 63 |
| `@bunest/terminus` | 0 | 22 | 0 / 16 | 0 | 1 | 23 |
| `@bunest/scheduler` | 3 | 17 | 2 / 9 | 0 | 0 | 20 |
| `@bunest/cli` | 1 | 16 | 1 / 3 | 0 | 6 | 23 |
| `@bunest/prisma` | 0 | 9 | 0 / 3 | 0 | 0 | 9 |
| `tests` | 0 | 0 | 0 / 0 | 705 | 1946 | 2651 |
| `@bunest/passport` | 0 | 0 | 0 / 0 | 9 | 0 | 9 |
| `benchmarks` | 0 | 0 | 0 / 0 | 0 | 0 | 6 |
| `@bunest/mapped-types` | 0 | 0 | 0 / 0 | 0 | 6 | 6 |
| `examples/auth-jwt-sqlite` | 0 | 0 | 0 / 0 | 0 | 0 | 4 |
| `examples/rest-crud` | 0 | 0 | 0 / 0 | 0 | 3 | 4 |
| `apps/playground` | 0 | 0 | 0 / 0 | 2 | 2 | 4 |
| `apps/docs` | 0 | 0 | 0 / 0 | 0 | 2 | 3 |
| `examples/websocket-chat` | 0 | 0 | 0 / 0 | 0 | 1 | 2 |
| `examples/distributed-worker` | 0 | 0 | 0 / 0 | 0 | 0 | 1 |
| `@bunest/devtools-integration` | 0 | 0 | 0 / 0 | 0 | 1 | 1 |

## 6. Top 40 Production Files (`packages/*/src`)

| File | `any` | `unknown` | Public API | Total | Top Patterns |
| --- | ---: | ---: | ---: | ---: | --- |
| `packages/mongoose/src/interfaces/schema-types.interface.ts` | 87 | 88 | 175 | 175 | variadic-constructor-or-fn(101), record-string-unknown(19), generic-default-any(14) |
| `packages/core/src/di/di-container.ts` | 25 | 138 | 47 | 163 | other(98), generic-default-unknown(14), untyped-parameter(11) |
| `packages/common/src/utils/pattern-match.util.ts` | 0 | 161 | 23 | 161 | other(34), conditional-type-check(31), array-any-or-unknown(29) |
| `packages/common/src/decorators/class-macros.decorators.ts` | 0 | 145 | 5 | 145 | record-string-unknown(53), variadic-constructor-or-fn(42), untyped-parameter(14) |
| `packages/typeorm/src/runtime/typeorm-runtime.ts` | 7 | 137 | 96 | 144 | record-string-unknown(75), array-any-or-unknown(14), other(14) |
| `packages/mongoose/src/driver/schema.ts` | 52 | 86 | 99 | 138 | variadic-constructor-or-fn(76), other(15), untyped-parameter(14) |
| `packages/mongoose/src/driver/connection.ts` | 15 | 108 | 45 | 123 | record-string-unknown(63), double-cast(16), other(14) |
| `packages/common/src/interfaces/nest-compat.interface.ts` | 42 | 77 | 119 | 119 | untyped-return(66), generic-default-any(21), variadic-constructor-or-fn(15) |
| `packages/http/src/adapter/abstract-http.adapter.ts` | 5 | 111 | 106 | 116 | untyped-return(76), variadic-constructor-or-fn(28), generic-default-any(5) |
| `packages/sequelize/src/runtime/sequelize-runtime.ts` | 41 | 67 | 97 | 108 | record-string-unknown(38), variadic-constructor-or-fn(29), record-string-any(14) |
| `packages/graphql/src/interfaces/graphql.interface.ts` | 48 | 56 | 102 | 104 | variadic-constructor-or-fn(27), generic-default-any(23), record-string-unknown(20) |
| `packages/elasticsearch/src/interfaces/elasticsearch-types.interface.ts` | 4 | 85 | 89 | 89 | record-string-unknown(39), index-signature(21), generic-default-unknown(13) |
| `packages/queues/src/adapters/bullmq.adapter.ts` | 2 | 85 | 30 | 87 | other(39), generic-default-unknown(26), variadic-constructor-or-fn(6) |
| `packages/core/src/helpers/external-context-creator.ts` | 2 | 81 | 39 | 83 | variadic-constructor-or-fn(21), generic-default-unknown(15), array-any-or-unknown(12) |
| `packages/graphql/src/schema/graphql-schema.factory.ts` | 27 | 54 | 1 | 81 | other(42), record-string-unknown(13), untyped-parameter(9) |
| `packages/queues/src/interfaces.ts` | 15 | 61 | 76 | 76 | generic-default-unknown(37), variadic-constructor-or-fn(17), record-string-unknown(12) |
| `packages/sql/src/declarative-repository.ts` | 1 | 61 | 3 | 62 | record-string-unknown(31), array-any-or-unknown(7), untyped-parameter(6) |
| `packages/microservices/src/interfaces.ts` | 13 | 48 | 56 | 61 | record-string-unknown(24), untyped-property(7), variadic-constructor-or-fn(7) |
| `packages/common/src/utils/object.util.ts` | 0 | 61 | 21 | 61 | record-string-unknown(40), untyped-parameter(9), other(4) |
| `packages/observability/src/health/health-indicator.service.ts` | 23 | 37 | 27 | 60 | other(17), record-string-unknown(16), untyped-parameter(8) |
| `packages/common/src/logger/console-logger.ts` | 0 | 58 | 12 | 58 | untyped-parameter(17), record-string-unknown(17), variadic-constructor-or-fn(7) |
| `packages/security/src/auth/auth-strategy.ts` | 5 | 51 | 17 | 56 | untyped-parameter(10), record-string-unknown(10), map-set-promise-container(8) |
| `packages/security/src/auth/passport.compat.ts` | 17 | 39 | 36 | 56 | variadic-constructor-or-fn(12), untyped-parameter(10), error-or-catch(7) |
| `packages/common/src/utils/type-guards.util.ts` | 0 | 54 | 49 | 54 | untyped-parameter(31), variadic-constructor-or-fn(7), array-any-or-unknown(6) |
| `packages/websockets/src/adapter/bun-ws.adapter.ts` | 0 | 52 | 17 | 52 | untyped-parameter(11), record-string-unknown(10), variadic-constructor-or-fn(10) |
| `packages/workflows/src/services/workflow-execution.service.ts` | 4 | 47 | 16 | 51 | variadic-constructor-or-fn(17), untyped-property(12), other(6) |
| `packages/swagger/src/interfaces/openapi.interface.ts` | 3 | 47 | 48 | 50 | untyped-property(14), record-string-unknown(11), other(7) |
| `packages/apollo/src/drivers/apollo-base.driver.ts` | 7 | 43 | 6 | 50 | untyped-parameter(14), record-string-unknown(13), variadic-constructor-or-fn(13) |
| `packages/config/src/config.service.ts` | 20 | 29 | 17 | 49 | record-string-unknown(15), other(12), generic-default-any(9) |
| `packages/common/src/pipes/built-in.pipes.ts` | 0 | 49 | 20 | 49 | untyped-parameter(18), variadic-constructor-or-fn(10), other(10) |
| `packages/queues/src/queue.module.ts` | 33 | 15 | 7 | 48 | other(25), record-string-unknown(6), generic-default-any(5) |
| `packages/testing/src/mocker/module-mocker.ts` | 8 | 40 | 20 | 48 | other(9), array-any-or-unknown(7), double-cast(7) |
| `packages/sqlite/src/declarative-repository.ts` | 1 | 46 | 2 | 47 | record-string-unknown(26), variadic-constructor-or-fn(7), untyped-parameter(5) |
| `packages/axios/src/http.service.ts` | 29 | 16 | 20 | 45 | generic-default-any(20), record-string-unknown(7), record-string-any(5) |
| `packages/idempotency/src/contexts/http.context.ts` | 0 | 45 | 6 | 45 | untyped-parameter(17), other(8), untyped-return(7) |
| `packages/microservices/src/helpers.ts` | 2 | 42 | 21 | 44 | untyped-parameter(9), untyped-property(8), record-string-unknown(7) |
| `packages/swagger/src/swagger-module.ts` | 4 | 40 | 1 | 44 | other(29), record-string-unknown(7), untyped-property(6) |
| `packages/elasticsearch/src/elasticsearch.service.ts` | 0 | 44 | 44 | 44 | generic-default-unknown(34), record-string-unknown(10) |
| `packages/graphql/src/context/gql-execution-context.ts` | 29 | 15 | 24 | 44 | generic-default-any(27), record-string-unknown(6), other(5) |
| `packages/core/src/application/bunest-application.ts` | 3 | 40 | 2 | 43 | other(20), double-cast(7), variadic-constructor-or-fn(4) |

## 7. Container Generic Types (`packages/*/src`)

| Container Type | `any` | `unknown` | Total |
| --- | ---: | ---: | ---: |
| `Record<...>` | 66 | 1607 | 1673 |
| `Type<...>` | 58 | 389 | 447 |
| `Promise<...>` | 12 | 188 | 200 |
| `Job<...>` | 38 | 10 | 48 |
| `PromiseLike<...>` | 0 | 41 | 41 |
| `Map<...>` | 0 | 40 | 40 |
| `Abstract<...>` | 6 | 33 | 39 |
| `Queue<...>` | 18 | 6 | 24 |
| `ICommandHandler<...>` | 9 | 7 | 16 |
| `HealthCheckAttempt<...>` | 15 | 0 | 15 |
| `IQueryHandler<...>` | 7 | 7 | 14 |
| `StandardSchemaV1<...>` | 8 | 6 | 14 |
| `MongooseSchemaLike<...>` | 12 | 2 | 14 |
| `GraphQLFieldConfigMap<...>` | 14 | 0 | 14 |
| `AsyncIterable<...>` | 0 | 13 | 13 |
| `Mailable<...>` | 12 | 0 | 12 |
| `ConfigChangeEvent<...>` | 11 | 0 | 11 |
| `BullJob<...>` | 10 | 0 | 10 |
| `MongooseSchema<...>` | 8 | 2 | 10 |
| `AuthenticationResult<...>` | 8 | 2 | 10 |
| `Array<...>` | 8 | 1 | 9 |
| `GraphQLFieldResolver<...>` | 9 | 0 | 9 |
| `BullMQWorkerLike<...>` | 4 | 4 | 8 |
| `PrismaClientLike<...>` | 8 | 0 | 8 |
| `Subscribable<...>` | 0 | 7 | 7 |

## 8. Production `any` Occurrences (1431 total)

> 1431 production `any` occurrences found — see `any-unknown-report.json` for the complete list. Showing first 150 Public API `any` occurrences:

- `packages/microservices/src/client-interfaces.ts:18` `other` (interface CustomClientOptions.customClass) — `customClass: Type<ClientProxy<any, any>>;`
- `packages/microservices/src/client-interfaces.ts:18` `other` (interface CustomClientOptions.customClass) — `customClass: Type<ClientProxy<any, any>>;`
- `packages/microservices/src/client-interfaces.ts:48` `variadic-constructor-or-fn` (interface ClientsProviderAsyncOptions.useFactory) — `...args: any[]`
- `packages/microservices/src/client-proxy.ts:133` `map-set-promise-container` (ClientProxy.connect()) — `abstract connect(): Promise<any>;`
- `packages/microservices/src/client-proxy.ts:157` `generic-default-any` (ClientProxy.send()) — `send<TRes = any, TReq = any, TPattern extends PatternInput = PatternInput>(`
- `packages/microservices/src/client-proxy.ts:157` `generic-default-any` (ClientProxy.send()) — `send<TRes = any, TReq = any, TPattern extends PatternInput = PatternInput>(`
- `packages/microservices/src/client-proxy.ts:164` `generic-default-any` (ClientProxy.send()) — `async send<TRes = any, TReq = any>(`
- `packages/microservices/src/client-proxy.ts:164` `generic-default-any` (ClientProxy.send()) — `async send<TRes = any, TReq = any>(`
- `packages/microservices/src/client-proxy.ts:219` `generic-default-any` (ClientProxy.emit()) — `emit<TReq = any, TPattern extends PatternInput = PatternInput>(`
- `packages/microservices/src/client-proxy.ts:225` `generic-default-any` (ClientProxy.emit()) — `async emit<TReq = any>(pattern: PatternInput, data: TReq): Promise<void> {`
- `packages/microservices/src/ctx-host.ts:29` `generic-default-any` (BaseRpcContext.getArgByIndex()) — `getArgByIndex<TResult = any>(index: number): TResult {`
- `packages/microservices/src/ctx-host.ts:56` `generic-default-any` (TcpContext.getSocketRef()) — `getSocketRef<T = any>(): T {`
- `packages/microservices/src/ctx-host.ts:140` `generic-default-any` (NatsContext.getHeaders()) — `getHeaders<T = any>(): T {`
- `packages/microservices/src/ctx-host.ts:200` `record-string-any` (RmqContext.getMessage()) — `getMessage<T = Record<string, any>>(): T {`
- `packages/microservices/src/ctx-host.ts:207` `generic-default-any` (RmqContext.getChannelRef()) — `getChannelRef<T = any>(): T {`
- `packages/microservices/src/ctx-host.ts:239` `generic-default-any` (interface RequestContext) — `TData = any,`
- `packages/microservices/src/ctx-host.ts:240` `generic-default-any` (interface RequestContext) — `TContext extends BaseRpcContext = any,`
- `packages/microservices/src/enums.ts:164` `variadic-constructor-or-fn` (type NatsEvents.update) — `update: (data?: string | number | ServersChangedEvent) => any;`
- `packages/microservices/src/exceptions.ts:288` `generic-default-any` (BaseRpcExceptionFilter) — `T = any,`
- `packages/microservices/src/exceptions.ts:289` `generic-default-any` (BaseRpcExceptionFilter) — `R = any,`
- `packages/microservices/src/helpers.ts:143` `generic-default-any` (KafkaParser.parse()) — `public parse<T = any>(data: unknown): T {`
- `packages/microservices/src/helpers.ts:480` `variadic-constructor-or-fn` (interface JsonSocketStreamLike.on()) — `on?(event: string, listener: (...args: any[]) => void): unknown;`
- `packages/microservices/src/interfaces.ts:72` `generic-default-any` (interface MessageHandler) — `TInput = any,`
- `packages/microservices/src/interfaces.ts:74` `generic-default-any` (interface MessageHandler) — `TResult = any,`
- `packages/microservices/src/interfaces.ts:79` `record-string-any` (interface MessageHandler.extras) — `extras?: Record<string, any>;`
- `packages/microservices/src/interfaces.ts:128` `variadic-constructor-or-fn` (interface CustomTransportStrategy.listen()) — `listen(callback?: (...optionalParams: unknown[]) => any): any;`
- `packages/microservices/src/interfaces.ts:128` `variadic-constructor-or-fn` (interface CustomTransportStrategy.listen()) — `listen(callback?: (...optionalParams: unknown[]) => any): any;`
- `packages/microservices/src/interfaces.ts:129` `untyped-return` (interface CustomTransportStrategy.close()) — `close(): any;`
- `packages/microservices/src/interfaces.ts:135` `record-string-any` (interface CustomStrategy.options) — `options?: Record<string, any>;`
- `packages/microservices/src/interfaces.ts:150` `other` (interface TcpTransportOptions.socketClass) — `readonly socketClass?: Type<any>;`
- `packages/microservices/src/interfaces.ts:353` `variadic-constructor-or-fn` (interface GrpcTransportOptions.onLoadPackageDefinition) — `readonly onLoadPackageDefinition?: (pkg: any, server: any) => void;`
- `packages/microservices/src/interfaces.ts:353` `variadic-constructor-or-fn` (interface GrpcTransportOptions.onLoadPackageDefinition) — `readonly onLoadPackageDefinition?: (pkg: any, server: any) => void;`
- `packages/microservices/src/interfaces.ts:580` `variadic-constructor-or-fn` (type AsyncOptions.useFactory) — `useFactory: (...args: any[]) => T | Promise<T>;`
- `packages/microservices/src/interfaces.ts:586` `variadic-constructor-or-fn` (type AsyncMicroserviceOptions.useFactory) — `...args: any[]`
- `packages/microservices/src/interfaces.ts:592` `generic-default-any` (interface ClientGrpc.getClientByServiceName()) — `getClientByServiceName<T = any>(name: string): T;`
- `packages/microservices/src/microservice-host.ts:163` `other` (MicroserviceHost.registerPreRequestHook()) — `registerPreRequestHook(...hooks: PreRequestHook<any>[]): this {`
- `packages/microservices/src/microservice-host.ts:240` `generic-default-any` (MicroserviceHost.registerRequestByContextId()) — `registerRequestByContextId<T = any>(request: T, contextId: ContextId): void {`
- `packages/microservices/src/packets.ts:11` `generic-default-any` (interface ReadPacket) — `export interface ReadPacket<T = any> {`
- `packages/microservices/src/packets.ts:17` `generic-default-any` (interface WritePacket) — `export interface WritePacket<T = any> {`
- `packages/microservices/src/packets.ts:39` `generic-default-any` (interface Serializer) — `export interface Serializer<TInput = any, TOutput = any> {`
- `packages/microservices/src/packets.ts:39` `generic-default-any` (interface Serializer) — `export interface Serializer<TInput = any, TOutput = any> {`
- `packages/microservices/src/packets.ts:52` `generic-default-any` (interface Deserializer) — `export interface Deserializer<TInput = any, TOutput = any> {`
- `packages/microservices/src/packets.ts:52` `generic-default-any` (interface Deserializer) — `export interface Deserializer<TInput = any, TOutput = any> {`
- `packages/microservices/src/packets.ts:59` `other` (type ProducerDeserializer) — `export type ProducerDeserializer = Deserializer<any, IncomingResponse>;`
- `packages/microservices/src/packets.ts:61` `other` (type ConsumerDeserializer) — `any,`
- `packages/microservices/src/records.ts:24` `generic-default-any` (RmqRecord) — `export class RmqRecord<TData = any> {`
- `packages/microservices/src/records.ts:31` `generic-default-any` (RmqRecordBuilder) — `export class RmqRecordBuilder<TData = any> {`
- `packages/microservices/src/records.ts:51` `generic-default-any` (NatsRecord) — `export class NatsRecord<TData = any, THeaders = Record<string, string>> {`
- `packages/microservices/src/records.ts:58` `generic-default-any` (NatsRecordBuilder) — `export class NatsRecordBuilder<TData = any, THeaders = Record<string, string>> {`
- `packages/microservices/src/records.ts:85` `generic-default-any` (MqttRecord) — `export class MqttRecord<TData = any> {`
- `packages/microservices/src/records.ts:92` `generic-default-any` (MqttRecordBuilder) — `export class MqttRecordBuilder<TData = any> {`
- `packages/microservices/src/records.ts:131` `generic-default-any` (RedisRecord) — `export class RedisRecord<TData = any> {`
- `packages/microservices/src/records.ts:138` `generic-default-any` (RedisRecordBuilder) — `export class RedisRecordBuilder<TData = any> {`
- `packages/microservices/src/rpc-context.ts:24` `generic-default-any` (RpcExecutionContext.getClass()) — `getClass<T = any>(): Type<T> {`
- `packages/microservices/src/rpc-context.ts:40` `array-any-or-unknown` (RpcExecutionContext.getArgs()) — `getArgs<T extends Array<any> = any[]>(): T {`
- `packages/microservices/src/rpc-context.ts:40` `array-any-or-unknown` (RpcExecutionContext.getArgs()) — `getArgs<T extends Array<any> = any[]>(): T {`
- `packages/microservices/src/rpc-context.ts:44` `generic-default-any` (RpcExecutionContext.getArgByIndex()) — `getArgByIndex<T = any>(index: number): T {`
- `packages/cqrs/src/aggregate-root.ts:69` `other` (AggregateRoot.commit()) — `commit(dispatcherContext?: unknown): Promise<void> | any {`
- `packages/cqrs/src/aggregate-root.ts:108` `other` (AggregateRoot.publish()) — `): Promise<void> | any {`
- `packages/cqrs/src/command-bus.ts:114` `other` (CommandBus.bind()) — `handler: InstanceWrapper<ICommandHandler<T, any>> | ICommandHandler<T, any>,`
- `packages/cqrs/src/command-bus.ts:114` `other` (CommandBus.bind()) — `handler: InstanceWrapper<ICommandHandler<T, any>> | ICommandHandler<T, any>,`
- `packages/cqrs/src/command-bus.ts:138` `other` (CommandBus.register()) — `handlers?: InstanceWrapper<ICommandHandler<CommandBase, any>>[],`
- `packages/cqrs/src/command-bus.ts:142` `other` (CommandBus.register()) — `CommandType<any> | InstanceWrapper<ICommandHandler<CommandBase, any>>[],`
- `packages/cqrs/src/command-bus.ts:142` `other` (CommandBus.register()) — `CommandType<any> | InstanceWrapper<ICommandHandler<CommandBase, any>>[],`
- `packages/cqrs/src/command-bus.ts:143` `other` (CommandBus.register()) — `maybeHandler?: ICommandHandler<any, any>,`
- `packages/cqrs/src/command-bus.ts:143` `other` (CommandBus.register()) — `maybeHandler?: ICommandHandler<any, any>,`
- `packages/cqrs/src/command-bus.ts:275` `generic-default-any` (CommandBus.execute()) — `execute<TResult = any, TCommand extends CommandBase = CommandBase>(`
- `packages/cqrs/src/command-bus.ts:279` `generic-default-any` (CommandBus.execute()) — `execute<TCommand extends CommandBase, TResult = any>(`
- `packages/cqrs/src/event-bus.ts:218` `other` (EventBus.register()) — `EventType<any> | InstanceWrapper<IEventHandler<EventBase>>[],`
- `packages/cqrs/src/event-bus.ts:219` `other` (EventBus.register()) — `maybeHandler?: IEventHandler<any>,`
- `packages/cqrs/src/event-bus.ts:433` `other` (EventBus.publish()) — `publish<TEvent extends EventBase>(event: TEvent): Promise<void> | any;`
- `packages/cqrs/src/event-bus.ts:437` `other` (EventBus.publish()) — `): Promise<void> | any;`
- `packages/cqrs/src/event-bus.ts:441` `other` (EventBus.publish()) — `): Promise<void> | any;`
- `packages/cqrs/src/event-bus.ts:446` `other` (EventBus.publish()) — `): Promise<void> | any;`
- `packages/cqrs/src/event-bus.ts:451` `other` (EventBus.publish()) — `): Promise<void> | any {`
- `packages/cqrs/src/event-bus.ts:478` `other` (EventBus.publishAll()) — `): Promise<void> | any;`
- `packages/cqrs/src/event-bus.ts:482` `other` (EventBus.publishAll()) — `): Promise<void> | any;`
- `packages/cqrs/src/event-bus.ts:486` `other` (EventBus.publishAll()) — `): Promise<void> | any;`
- `packages/cqrs/src/event-bus.ts:491` `other` (EventBus.publishAll()) — `): Promise<void> | any;`
- `packages/cqrs/src/event-bus.ts:496` `other` (EventBus.publishAll()) — `): Promise<void> | any {`
- `packages/cqrs/src/interfaces.ts:39` `generic-default-any` (type ICommandHandler) — `export type ICommandHandler<TCommand extends ICommand = any, TResult = any> =`
- `packages/cqrs/src/interfaces.ts:39` `generic-default-any` (type ICommandHandler) — `export type ICommandHandler<TCommand extends ICommand = any, TResult = any> =`
- `packages/cqrs/src/interfaces.ts:54` `generic-default-any` (type IQueryHandler) — `export type IQueryHandler<TQuery extends IQuery = any, TResult = any> =`
- `packages/cqrs/src/interfaces.ts:54` `generic-default-any` (type IQueryHandler) — `export type IQueryHandler<TQuery extends IQuery = any, TResult = any> =`
- `packages/cqrs/src/interfaces.ts:65` `generic-default-any` (interface IEventHandler) — `export interface IEventHandler<TEvent extends IEvent = any> {`
- `packages/cqrs/src/interfaces.ts:91` `generic-default-any` (interface ICommandBus.execute()) — `execute<TResult = any, TCommand extends CommandBase = CommandBase>(`
- `packages/cqrs/src/interfaces.ts:95` `generic-default-any` (interface ICommandBus.execute()) — `execute<TCommand extends CommandBase, TResult = any>(`
- `packages/cqrs/src/interfaces.ts:111` `generic-default-any` (interface IQueryBus.execute()) — `execute<TResult = any, TQuery extends QueryBase = QueryBase>(`
- `packages/cqrs/src/interfaces.ts:115` `generic-default-any` (interface IQueryBus.execute()) — `execute<TQuery extends QueryBase, TResult = any>(`
- `packages/cqrs/src/interfaces.ts:122` `untyped-return` (interface IEventBus.publish()) — `publish<TEvent extends EventBase>(event: TEvent): any;`
- `packages/cqrs/src/interfaces.ts:126` `untyped-return` (interface IEventBus.publish()) — `): any;`
- `packages/cqrs/src/interfaces.ts:130` `untyped-return` (interface IEventBus.publish()) — `): any;`
- `packages/cqrs/src/interfaces.ts:135` `untyped-return` (interface IEventBus.publish()) — `): any;`
- `packages/cqrs/src/interfaces.ts:137` `untyped-return` (interface IEventBus.publishAll()) — `publishAll<TEvent extends EventBase>(events: readonly TEvent[]): any;`
- `packages/cqrs/src/interfaces.ts:141` `untyped-return` (interface IEventBus.publishAll()) — `): any;`
- `packages/cqrs/src/interfaces.ts:145` `untyped-return` (interface IEventBus.publishAll()) — `): any;`
- `packages/cqrs/src/interfaces.ts:150` `untyped-return` (interface IEventBus.publishAll()) — `): any;`
- `packages/cqrs/src/interfaces.ts:154` `untyped-return` (interface ICommandPublisher.publish()) — `publish<T extends CommandBase = CommandBase>(command: T): any;`
- `packages/cqrs/src/interfaces.ts:158` `untyped-return` (interface IQueryPublisher.publish()) — `publish<T extends QueryBase = QueryBase>(query: T): any;`
- `packages/cqrs/src/interfaces.ts:166` `untyped-return` (interface IEventPublisher.publish()) — `): any;`
- `packages/cqrs/src/interfaces.ts:171` `untyped-return` (interface IEventPublisher.publishAll()) — `): any;`
- `packages/cqrs/src/interfaces.ts:175` `untyped-return` (interface IMessageSource.bridgeEventsTo()) — `bridgeEventsTo<T extends EventBase>(subject: SubjectLike<T>): any;`
- `packages/cqrs/src/interfaces.ts:214` `untyped-return` (interface IAggregateRoot.publish()) — `): any;`
- `packages/cqrs/src/interfaces.ts:218` `untyped-return` (interface IAggregateRoot.publishAll()) — `): any;`
- `packages/cqrs/src/interfaces.ts:219` `untyped-return` (interface IAggregateRoot.commit()) — `commit(dispatcherContext?: unknown): any;`
- `packages/cqrs/src/interfaces.ts:335` `variadic-constructor-or-fn` (interface CqrsModuleAsyncOptions.useFactory) — `...args: any[]`
- `packages/cqrs/src/query-bus.ts:112` `generic-default-any` (QueryBus.bind()) — `bind<T extends QueryBase, TResult extends IQueryResult = any>(`
- `packages/cqrs/src/query-bus.ts:135` `other` (QueryBus.register()) — `register(handlers?: InstanceWrapper<IQueryHandler<QueryBase, any>>[]): void;`
- `packages/cqrs/src/query-bus.ts:138` `other` (QueryBus.register()) — `QueryType<any> | InstanceWrapper<IQueryHandler<QueryBase, any>>[],`
- `packages/cqrs/src/query-bus.ts:138` `other` (QueryBus.register()) — `QueryType<any> | InstanceWrapper<IQueryHandler<QueryBase, any>>[],`
- `packages/cqrs/src/query-bus.ts:139` `other` (QueryBus.register()) — `maybeHandler?: IQueryHandler<any, any>,`
- `packages/cqrs/src/query-bus.ts:139` `other` (QueryBus.register()) — `maybeHandler?: IQueryHandler<any, any>,`
- `packages/cqrs/src/query-bus.ts:264` `generic-default-any` (QueryBus.execute()) — `execute<TResult = any, TQuery extends QueryBase = QueryBase>(`
- `packages/cqrs/src/query-bus.ts:268` `generic-default-any` (QueryBus.execute()) — `execute<TQuery extends QueryBase, TResult = any>(`
- `packages/cqrs/src/unhandled-exception-bus.ts:47` `generic-default-any` (UnhandledExceptionBus.ofType()) — `static ofType<TInput = any, TOutput = IEvent | ICommand>(`
- `packages/cqrs/src/unhandled-exception-bus.ts:48` `other` (UnhandledExceptionBus.ofType()) — `...types: Type<any>[]`
- `packages/cqrs/src/unhandled-exception-bus.ts:83` `untyped-return` (UnhandledExceptionBus.publish()) — `publish(info: UnhandledExceptionInfo<Cause>): any {`
- `packages/swagger/src/document-builder.ts:119` `record-string-any` (DocumentBuilder.addServer()) — `serverExtraProperties?: Record<string, any>,`
- `packages/swagger/src/plugin-metadata-store.ts:87` `record-string-any` (function registerLoadedPluginMetadata()) — `rawMetadata: Record<string, any>,`
- `packages/swagger/src/schema-explorer.ts:1128` `generic-default-any` (function generateSchema()) — `export function generateSchema<T = any>(`
- `packages/swagger/src/swagger-module.ts:619` `record-string-any` (SwaggerModule.loadPluginMetadata()) — `metadataFn: () => Promise<Record<string, any>>,`
- `packages/config/src/config.service.ts:209` `other` (ConfigService.get changes$()) — `get changes$(): ConfigSubscribable<ConfigChangeEvent<any, any>> {`
- `packages/config/src/config.service.ts:209` `other` (ConfigService.get changes$()) — `get changes$(): ConfigSubscribable<ConfigChangeEvent<any, any>> {`
- `packages/config/src/config.service.ts:248` `generic-default-any` (ConfigService.get()) — `get<T = any>(propertyPath: KeyOf<K>): ValidatedResult<WasValidated, T>;`
- `packages/config/src/config.service.ts:254` `generic-default-any` (ConfigService.get()) — `P extends Path<T> = any,`
- `packages/config/src/config.service.ts:270` `generic-default-any` (ConfigService.get()) — `get<T = any>(propertyPath: KeyOf<K>, defaultValue: NoInferType<T>): T;`
- `packages/config/src/config.service.ts:276` `generic-default-any` (ConfigService.get()) — `P extends Path<T> = any,`
- `packages/config/src/config.service.ts:321` `generic-default-any` (ConfigService.getOrThrow()) — `getOrThrow<T = any>(propertyPath: KeyOf<K>): Exclude<T, undefined>;`
- `packages/config/src/config.service.ts:324` `generic-default-any` (ConfigService.getOrThrow()) — `P extends Path<T> = any,`
- `packages/config/src/config.service.ts:333` `generic-default-any` (ConfigService.getOrThrow()) — `getOrThrow<T = any>(`
- `packages/config/src/config.service.ts:339` `generic-default-any` (ConfigService.getOrThrow()) — `P extends Path<T> = any,`
- `packages/config/src/config.service.ts:371` `generic-default-any` (ConfigService.set()) — `set<T = any>(`
- `packages/mail/src/mailer.service.ts:84` `other` (Mailer.send()) — `send<M extends Mailable<any>>(`
- `packages/mail/src/mailer.service.ts:89` `decorator-or-reflect` (Mailer.send()) — `target: MailSendOptions | Type<Mailable<any>>,`
- `packages/mail/src/mailer.service.ts:111` `other` (Mailer.render()) — `render<M extends Mailable<any>>(`
- `packages/mail/src/mailer.service.ts:118` `decorator-or-reflect` (Mailer.render()) — `target: MailRenderOptions | Type<Mailable<any>>,`
- `packages/scheduler/src/scheduler.explorer.ts:215` `other` (SchedulerExplorer.warnForNonStaticProviders()) — `wrapper: InstanceWrapper<any>,`
- `packages/sqlite/src/declarative-repository.ts:124` `generic-default-any` (function SqliteRepository()) — `export function SqliteRepository<TEntity = any>(`
- `packages/sqlite/src/interfaces.ts:149` `other` (interface SqliteFeatureRepositoryConfig.entity) — `readonly entity?: Type<any>;`
- `packages/sqlite/src/interfaces.ts:154` `other` (type SqliteRepositoryTarget) — `string | Type<any> | Abstract<any> | SqliteFeatureRepositoryConfig;`
- `packages/sqlite/src/interfaces.ts:154` `other` (type SqliteRepositoryTarget) — `string | Type<any> | Abstract<any> | SqliteFeatureRepositoryConfig;`
- `packages/sqlite/src/interfaces.ts:210` `generic-default-any` (interface SqliteRepositoryOptions) — `export interface SqliteRepositoryOptions<TEntity = any> {`
- `packages/sqlite/src/interfaces.ts:260` `generic-default-any` (interface SqliteRepositoryMetadata) — `export interface SqliteRepositoryMetadata<TEntity = any> {`
- `packages/sqlite/src/interfaces.ts:446` `variadic-constructor-or-fn` (interface SqliteModuleAsyncOptions.useFactory) — `...args: any[]`
- `packages/testing/src/supertest-request.ts:23` `untyped-property` (interface SupertestResponse.body) — `readonly body: any;`
- `packages/graphql/src/graphql.module.ts:158` `record-string-any` (GraphQLModule.forRoot()) — `static forRoot<TOptions extends Record<string, any> = GraphQLModuleOptions>(`
- `packages/graphql/src/graphql.module.ts:190` `record-string-any` (GraphQLModule.forRootAsync()) — `TOptions extends Record<string, any> = GraphQLModuleOptions,`
- `packages/queues/src/flow-producer.ts:14` `other` (interface FlowProducerQueueResolver.get()) — `get(name: string): Queue<any, any> | undefined;`
- `packages/queues/src/flow-producer.ts:14` `other` (interface FlowProducerQueueResolver.get()) — `get(name: string): Queue<any, any> | undefined;`
- `packages/queues/src/flow-producer.ts:15` `other` (interface FlowProducerQueueResolver.register()) — `register?(queue: Queue<any, any>): void;`
