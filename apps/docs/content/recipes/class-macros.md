# Class, Field & Method Macros

Bunest ships **27 Lombok-inspired, zero-dependency macros** in `@bunest/core` that eliminate repetitive boilerplate on DTOs, domain models, value objects, exceptions, and services—with full IDE hover/autocomplete and Delombok preview in the [Bunest VS Code Extension](/recipes/vscode-extension).

## Composite Model Macros

### `@Data()` & `@Value()`

- `@Data()` generates getters, setters, structural `equals()`, `hashCode()`, and a clean `toString()`.
- `@Value()` creates an **immutable** value object (frozen fields, getters only, `equals()`, `toString()`). Use `@NonFinal()` on a specific field to opt it out of immutability.

@@filename(money.value.ts)

```ts
import { Secret, Value } from "@bunest/core";

@Value()
export class Money {
  amount: number;
  currency: string;
}

@Value()
export class ApiCredential {
  clientId: string;

  @Secret()
  clientSecret: string; // redacted as "[REDACTED]" in toString() & JSON
}
```

### `@Builder()` & `@SuperBuilder()`

Generate a fluent builder API (`ClassName.builder()...build()`) with optional `@Singular()` collection builders:

@@filename(invoice.model.ts)

```ts
import { Builder, Data, Singular } from "@bunest/core";

@Data()
@Builder()
export class Invoice {
  id: string;
  customerId: string;

  @Singular()
  items: string[];
}
```

## Immutable Cloning (`@With`, `@WithBy`)

Generate non-mutating copy helpers (`withField(newValue)` / `withFieldBy(fn)`) on immutable domain models:

@@filename(user-settings.model.ts)

```ts
import { Value, With, WithBy } from "@bunest/core";

@Value()
@With()
@WithBy()
export class UserSettings {
  theme: "light" | "dark";
  retryLimit: number;
}
```

## Accessors, Field Defaults & Utilities

| Macro | Target | Behavior |
| --- | --- | --- |
| `@Getter()` / `@Setter()` | Class / Prop | Generates typed getter and/or setter methods. |
| `@Accessors({ fluent?, chain?, prefix? })` | Class / Prop | Configures fluent or chainable accessor naming. |
| `@ToString({ exclude?, includeFieldNames? })` | Class | Generates a deterministic `toString()` (automatically redacts `@Secret()` fields). |
| `@EqualsAndHashCode({ exclude? })` | Class | Generates deep value equality `equals(other)` and `hashCode()`. |
| `@FieldDefaults(options)` | Class | Sets default visibility/immutability behavior for all fields on a class. |
| `@FieldNameConstants()` | Class | Exposes a static `Fields` object mapping each property name to its string literal key. |
| `@Delegate()` | Prop | Delegates public methods of a nested object onto the parent class. |
| `@NonNull()` | Prop / Param | Throws a `TypeError` immediately if `null` or `undefined` is assigned/passed. |
| `@UtilityClass()` | Class | Prevents instantiation (`new Helper()` throws) for pure static utility classes. |
| `@StandardException()` | Class | Generates standard `(message?, cause?)` Error constructors with proper prototype chain. |
| `@JsonSerializable()` | Class | Adds a customized `toJSON()` honoring `@Secret()` and serialization options. |

## Method Aspect Macros

Apply operational behaviors directly to methods without manual wrappers:

| Macro | Purpose |
| --- | --- |
| `@Memoize({ ttlMs?, maxSize?, key? })` | Caches method return values in memory per argument key. |
| `@LogExecution({ level?, slowThresholdMs? })` | Logs method entry, duration, and errors automatically. |
| `@WithLogger(context?)` | Injects a contextual `Logger` instance onto the class (`this.logger`). |
| `@Synchronized(lockName?)` | Serializes concurrent async calls on the same instance via an internal mutex. |
| `@Locked(lockName?)` | Acquires a named re-entrant/exclusive lock around the method body. |

@@filename(exchange-rate.service.ts)

```ts
import {
  Injectable,
  LogExecution,
  Memoize,
  Synchronized,
  WithLogger,
} from "@bunest/core";

@Injectable()
@WithLogger("ExchangeRateService")
export class ExchangeRateService {
  @Memoize({ ttlMs: 60_000 })
  @LogExecution({ slowThresholdMs: 250 })
  async getRate(pair: string): Promise<number> {
    const res = await fetch(`https://rates.example.com/${pair}`);
    const data = (await res.json()) as { rate: number };
    return data.rate;
  }

  @Synchronized()
  async syncAllRates(): Promise<void> {
    // Guaranteed single-flight execution on this instance
  }
}
```

> tip **Zero-Save Typegen** Install the [Bunest VS Code Extension](/recipes/vscode-extension) to get instant autocomplete, hover signatures, and **Delombok** previews for every macro-generated method (`builder()`, `withX()`, `equals()`, etc.).
