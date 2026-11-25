# Logger

Bunest includes a structured **`Logger`** supporting log levels, context labels, JSON output mode for log aggregators, and **automatic deep immutable secret redaction**.

## Basic Usage

Instantiate `new Logger(ContextName)` inside any service, controller, guard, or interceptor:

@@filename(orders.service.ts)

```ts
import { Injectable, Logger } from "@bunest/core";

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  create(orderId: string, payload: Record<string, unknown>) {
    this.logger.log(`Creating order ${orderId}`, payload);
    this.logger.debug("Order validation completed");
    this.logger.warn("Inventory threshold approaching limit");
  }
}
```

Text mode output:

```text
[Bunest] 2026-11-20T03:00:00.000Z LOG [OrdersService] Creating order ord_42 {"sku":"BUN-1"}
```

## JSON Structured Mode & Custom Options

Pass `LoggerOptions` for machine-readable JSON logging (ideal for Datadog, Loki, OpenTelemetry, or CloudWatch):

@@filename(logger.config.ts)

```ts
import { Logger, type LoggerOptions } from "@bunest/core";

const prodLogger = new Logger("Bootstrap", {
  json: true,
  timestamp: true,
  levels: ["fatal", "error", "warn", "log"],
  redactKeys: ["internalApiKey", "stripeSecret"],
  redactionMask: "[REDACTED]",
});

Logger.overrideLogger(prodLogger);
```

## Built-In Deep Secret Redaction

Every object, nested array, `Headers`, `Map`, and `Error` logged through `Logger` is deep-cloned and redacted **without mutating the original input**. Circular references are safely formatted as `"[Circular]"`.

By default (`DEFAULT_REDACT_KEYS`), Bunest automatically masks keys matching (case/separator-insensitive):

`password`, `passwd`, `secret`, `token`, `accessToken`, `refreshToken`, `apiKey`, `authorization`, `cookie`, `setCookie`, `privateKey`, `clientSecret`, `creditCard`, `ssn`, `jwt`, `bearer`, `sessionId`

```ts
const logger = new Logger("Auth", { json: true });
logger.log("Login attempt", {
  email: "ada@bunest.dev",
  password: "super-secret-value",
  headers: new Headers({ Authorization: "Bearer eyJ..." }),
});
// Output:
// {"timestamp":"...","level":"log","context":"Auth","message":"Login attempt",
//  "meta":{"email":"ada@bunest.dev","password":"[REDACTED]","headers":{"authorization":"[REDACTED]"}}}
```

> tip **Custom `LoggerService`** Implement the `LoggerService` interface (`log`, `error`, `warn`, `debug?`, `verbose?`, `fatal?`) and pass it to `Logger.overrideLogger(myLogger)` to route Bunest logs through Pino, Winston, or OpenTelemetry.
