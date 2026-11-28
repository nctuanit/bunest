# Event Emitter (`30-event-emitter`)

Bunest counterpart of NestJS's [`sample/30-event-emitter`](https://github.com/nestjs/nest/tree/master/sample/30-event-emitter), built on `@bunest/messaging/events`:

- **`EventEmitterModule.forRoot({ wildcard: true })`**: Enables typed and wildcard event dispatch
- **Imperative emission**: `EventEmitter2.emitAsync("order.created", event)`
- **Declarative AOP emission**: `@EmitEvent("order.shipped")` automatically publishes return values as domain events
- **Listeners**: `@OnEvent("order.created")`, wildcard `@OnEvent("order.*")`, and `{ async: true }` listeners

## Run

```bash
bun run --cwd examples/event-emitter dev
bun run --cwd examples/event-emitter test
```
