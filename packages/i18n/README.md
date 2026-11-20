# @bunest/i18n

Internationalization (i18n) for Bunest with 100% NestJS v12 `@nestjs/i18n` API parity and zero external runtime dependencies: per-request `AsyncLocalStorage` locale resolution, typed translations, `Intl` formatting, and localized validation messages.

## Features

- **Per-Request `AsyncLocalStorage` Context**: `I18nContext`, `@CurrentLocale()`, and DI-free `t()` for translating anywhere in the request lifecycle.
- **Typed Translation Keys**: `I18nTypes` module augmentation (`I18nKey<T>`) with required numeric `count` enforcement for plural keys.
- **Catalog Loaders**: `I18nLoader`, `InMemoryI18nLoader`, and `JsonI18nLoader` with nested namespaces, symlink cycle detection, and debounced `fs.watch` hot reload.
- **Message Formatting**: `I18nMessageFormatter` with `{name}` placeholders, escaped `{{`/`}}`, and built-in `Intl` plural, select, number, and date formatting.
- **Locale Resolvers**: `LocaleResolver`, `AcceptLanguageLocaleResolver`, `CookieLocaleResolver`, `HeaderLocaleResolver`, and `QueryLocaleResolver`, plus `afterGuards` deferred resolution and `Vary` / `Content-Language` response headers.
- **Localized Validation**: Built-in support for both `class-validator` (`I18nValidationPipe`, `i18nValidationMessage`, `translateValidationErrors`) and Standard Schema v1 (`I18nStandardSchemaValidationPipe`, `i18nIssueMessage`, `translateStandardSchemaIssues`).

## Installation

```bash
bun add @bunest/i18n
```

## Quick Start

```ts
import { Controller, Get, Module } from "@bunest/common";
import {
  AcceptLanguageLocaleResolver,
  CurrentLocale,
  I18nModule,
  I18nService,
  JsonI18nLoader,
  QueryLocaleResolver,
} from "@bunest/i18n";
import { join } from "node:path";

@Controller("greeting")
export class GreetingController {
  constructor(private readonly i18n: I18nService) {}

  @Get()
  greet(@CurrentLocale() locale: string) {
    return {
      locale,
      message: this.i18n.t("common.hello", { args: { name: "Bunest" } }),
    };
  }
}

@Module({
  imports: [
    I18nModule.forRoot({
      defaultLocale: "en",
      loader: new JsonI18nLoader({
        path: join(import.meta.dirname, "i18n"),
      }),
      resolvers: [
        new QueryLocaleResolver("lang"),
        new AcceptLanguageLocaleResolver(),
      ],
    }),
  ],
  controllers: [GreetingController],
})
export class AppModule {}
```

## Key Exports

- **Module & Translation**: `I18nModule` (`forRoot`, `forRootAsync`), `I18N_MODULE_OPTIONS`, `I18nService`, `I18nContext`, `t`, `@CurrentLocale()`, `I18nMissingKeyError`, `I18nMessageFormatter`
- **Loaders**: `I18nLoader`, `InMemoryI18nLoader`, `JsonI18nLoader`
- **Locale Resolvers**: `LocaleResolver`, `AcceptLanguageLocaleResolver`, `CookieLocaleResolver`, `HeaderLocaleResolver`, `QueryLocaleResolver`
- **Validation**: `I18nValidationPipe`, `i18nValidationMessage`, `translateValidationErrors`, `I18nStandardSchemaValidationPipe`, `i18nIssueMessage`, `translateStandardSchemaIssues`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
