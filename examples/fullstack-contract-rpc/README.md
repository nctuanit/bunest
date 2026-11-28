# Full-Stack Contract-First RPC (`fullstack-contract-rpc`)

Solves NestJS's **"triple-definition" (DTO + Schema + OpenAPI)** and **missing end-to-end type safety** pain points using a single shared contract with **zero codegen**:

1. **Single Schema (`src/shared/contract.ts`)**: `s.*` (`@bunest/validation/schema`) + `defineContract()` / `defineRoute()`
2. **Type-Checked Server (`src/app.module.ts`)**: `FunctionalModule.forContract(appContract, handlers)` with full DI (`TasksService`) and route-level `ApiKeyGuard`
3. **Automatic OpenAPI 3.1**: `SwaggerModule.createDocument()` derives paths, params, query, requestBody, response schemas, tags, and summaries directly from the contract — zero `@Api*` decorators required
4. **Zero-Codegen Frontend Client (`src/client/demo-client.ts`)**: Browser-safe `createContractClient(appContract, ...)`
5. **Zero-Socket Typed E2E Testing (`test/fullstack-contract-rpc.e2e.spec.ts`)**: `testingModule.createContractClient(appContract, app)`

## Run

```bash
bun run --cwd examples/fullstack-contract-rpc dev
bun run --cwd examples/fullstack-contract-rpc test
```
