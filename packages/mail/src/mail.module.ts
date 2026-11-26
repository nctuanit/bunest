import {
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@bunest/core";
import { MailEvents } from "./events/mail-events.service";
import type {
  MailModuleAsyncOptions,
  MailModuleRootOptions,
} from "./interfaces/mail-module-options.interface";
import { LOCAL_TRANSPORT } from "./mail.constants";
import {
  ConfigurableModuleClass,
  MAIL_MODULE_OPTIONS,
  missingTransportError,
  type OPTIONS_TYPE,
} from "./mail.module-definition";
import { Mailer } from "./mailer.service";
import { MailTemplateEngine } from "./templates/mail-template.engine";
import { MailTransport } from "./transports/mail.transport";

/**
 * `MailModule.forRoot({ transport, templates, from, replyTo, headers, retry })`, or
 * `forRootAsync({ transport?, imports, inject, useFactory })` where the factory returns
 * the options, and may return the transport as an instance built from configuration.
 * Global by default. Provides `Mailer`, `MailEvents`, `MailTransport` and `MailTemplateEngine`
 * (`null` without `templates`).
 *
 * On shutdown, it waits for the sends in flight, then closes the transport (an SMTP
 * pool says QUIT) and completes `MailEvents.events$`.
 */
@Module({
  providers: [Mailer, MailEvents],
  exports: [
    Mailer,
    MailEvents,
    MailTransport,
    MailTemplateEngine,
    MAIL_MODULE_OPTIONS,
  ],
})
export class MailModule
  extends ConfigurableModuleClass
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    private readonly mailer: Mailer,
    private readonly transport: MailTransport,
    private readonly events: MailEvents,
  ) {
    super();
  }

  static override forRoot(options: MailModuleRootOptions): DynamicModule {
    if (options?.transport === undefined) {
      throw missingTransportError();
    }
    return super.forRoot(options as typeof OPTIONS_TYPE);
  }

  static override forRootAsync(options: MailModuleAsyncOptions): DynamicModule {
    return super.forRootAsync(options);
  }

  onApplicationBootstrap(): void {
    if (
      Reflect.get(process.env, "NODE_ENV") === "production" &&
      (this.transport as MailTransport & { [LOCAL_TRANSPORT]?: boolean })[
        LOCAL_TRANSPORT
      ]
    ) {
      new Logger("MailModule").warn(
        `The mail transport is ${this.transport.constructor.name}, which doesn't deliver mail, and ` +
          'NODE_ENV is "production". Configure SmtpTransport or a provider transport.',
      );
    }
  }

  // Runs after every module's onModuleDestroy(), where an outbox relay finishes the
  // handlers that are still sending, and after the MailEvents provider's own hooks.
  async onApplicationShutdown(): Promise<void> {
    await this.mailer.drain?.(); // absent when a test replaced the Mailer
    await this.transport.close?.();
    this.events.complete();
  }
}
