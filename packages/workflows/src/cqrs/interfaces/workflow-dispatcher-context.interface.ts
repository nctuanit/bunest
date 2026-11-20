/**
 * The dispatcher context `@bunest/workflows/cqrs` reads from `eventBus.publish(event, context)`,
 * `publishAll(events, context)` and an aggregate's `commit(context)`: `transaction` is your ORM's
 * transaction (Drizzle's `tx`, a TypeORM `EntityManager`, a Prisma transaction client), so the
 * workflows the events start and the signals they send commit with your writes, or not at all.
 */
export interface WorkflowDispatcherContext {
  transaction: unknown;
}
