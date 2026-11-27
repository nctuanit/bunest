# Migrating from class macros

Bunest removed the Lombok-style runtime decorators from `@bunest/core` in [commit 790eb87](https://github.com/nctuanit/bunest/commit/790eb87). If an older example imports `Data`, `Value` or `Builder` from core, migrate the class before upgrading. Framework decorators such as `@Injectable()` still work.

## Removed decorators

| Former use | Names to look for in your imports |
| --- | --- |
| Models, accessors and value semantics | `Data`, `Value`, `NonFinal`, `Getter`, `Setter`, `Accessors`, `ToString`, `EqualsAndHashCode`, `FieldDefaults`, `FieldNameConstants` |
| Construction, copying and delegation | `Builder`, `SuperBuilder`, `Singular`, `With`, `WithBy`, `Delegate`, `NonNull`, `UtilityClass`, `StandardException` |
| Serialization, logging, caching and locking | `Secret`, `JsonSerializable`, `WithLogger`, `Memoize`, `LogExecution`, `Synchronized`, `Locked` |

## Migrating a class

1. Find call sites that use generated members such as `Order.builder()`, `withQuantity()` or `equals()`. Implement the members those callers need before removing the decorators. For a former `@Value()` class, test runtime immutability if callers relied on it. TypeScript's `readonly` is checked at compile time.
2. For a field previously marked `@Secret()`, explicitly select the fields exposed by the response DTO and logger. Test both JSON output and log output with a dummy secret so redaction survives the migration.
3. For decorated service methods, test the behavior the application relies on. For example, verify when cached data expires or which concurrent calls must run in sequence. Then replace the decorator with the appropriate service or explicit method logic.

The CLI analyzer and VS Code tooling still recognize some historical macro names in source. An editor suggestion or Delombok preview alone does not supply a runtime export. Verify the migrated class with `bun check` and its behavior tests.
