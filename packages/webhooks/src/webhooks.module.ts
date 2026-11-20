import {
  type DynamicModule,
  Inject,
  MetadataRegistry,
  Module,
  type ModuleExport,
  type OnModuleInit,
  Optional,
  type Provider,
  type Type,
} from "@bunest/common";
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
} from "@bunest/core";
import { Outbox, OutboxInbox } from "@bunest/outbox";
import { WebhooksEvents } from "./events/webhooks-events.service";
import type { ResolvedWebhooksConfig } from "./interfaces/resolved-webhooks-config.interface";
import type {
  WebhooksModuleAsyncOptions,
  WebhooksModuleOptions,
  WebhooksModuleRootOptions,
  WebhooksModuleStructure,
} from "./interfaces/webhooks-module-options.interface";
import { HttpWebhookTransport } from "./network/http.transport";
import { WebhookDeliveries } from "./services/webhook-deliveries.service";
import { WebhookEndpoints } from "./services/webhook-endpoints.service";
import { WebhookFanOut } from "./services/webhook-fan-out.service";
import { WebhookVerifier } from "./services/webhook-verifier.service";
import { WebhookWorker } from "./services/webhook-worker.service";
import { WebhooksStorage } from "./storage/webhooks.storage";
import { WebhookTransport } from "./transports/webhook.transport";
import { resolveConfig } from "./utils/resolve-config.util";
import {
  LOCK_STORAGE,
  STORAGE_USED,
  VERIFY_WEBHOOK_METADATA,
  WEBHOOKS_CONFIG,
} from "./webhooks.constants";
import {
  ConfigurableModuleClass,
  WEBHOOKS_MODULE_OPTIONS,
} from "./webhooks.module-definition";
import { Webhooks } from "./webhooks.service";

/** Internal: `{ outgoing }`, for the module's startup checks. */
const WEBHOOKS_STRUCTURE = Symbol("WEBHOOKS_STRUCTURE");

/**
 * `WebhooksModule.forRoot({ eventTypes, retry, delivery, worker, receivers })`, or
 * `forRootAsync({ outgoing, transport, imports, inject, useFactory })`. Global by default.
 * Needs `OutboxModule`: sending dispatches through the outbox, and receiving deduplicates
 * with its inbox. Stores are providers of the app's that register with `WebhooksStorage`.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    {
      provide: WEBHOOKS_CONFIG,
      inject: [WEBHOOKS_MODULE_OPTIONS],
      useFactory: (options?: WebhooksModuleOptions) =>
        resolveConfig(options ?? {}),
    },
    WebhooksStorage,
    WebhooksEvents,
    WebhookVerifier,
  ],
  exports: [WebhooksStorage, WebhooksEvents, WebhookVerifier],
})
export class WebhooksModule
  extends ConfigurableModuleClass
  implements OnModuleInit
{
  private readonly storage: WebhooksStorage;
  private readonly discovery: DiscoveryService;
  private readonly scanner: MetadataScanner;
  private readonly config: ResolvedWebhooksConfig;
  private readonly structure: { outgoing: boolean };
  private readonly outbox?: Outbox;
  private readonly inbox?: OutboxInbox;

  constructor(
    storage: WebhooksStorage,
    discovery: DiscoveryService,
    scanner: MetadataScanner,
    @Inject(WEBHOOKS_CONFIG) config: ResolvedWebhooksConfig,
    @Inject(WEBHOOKS_STRUCTURE) structure: { outgoing: boolean },
    @Optional() outbox?: Outbox,
    @Optional() inbox?: OutboxInbox,
  ) {
    super();
    this.storage = storage;
    this.discovery = discovery;
    this.scanner = scanner;
    this.config = config;
    this.structure = structure;
    this.outbox = outbox;
    this.inbox = inbox;
    storage[STORAGE_USED] = structure.outgoing;
  }

  static override forRoot(
    options: WebhooksModuleRootOptions = {},
  ): DynamicModule {
    return withStructure(
      super.forRoot(options as Parameters<typeof ConfigurableModuleClass.forRoot>[0]),
      options,
    );
  }

  static override forRootAsync(
    options: WebhooksModuleAsyncOptions,
  ): DynamicModule {
    return withStructure(super.forRootAsync(options), options);
  }

  /**
   * Every provider constructor has run (stores registered themselves), and the worker starts
   * later, in `onApplicationBootstrap`. Checks what can't wait for the first request.
   */
  onModuleInit(): void {
    if (this.structure.outgoing && !this.outbox) {
      throw new Error(
        "WebhooksModule needs @bunest/outbox to send webhooks: import OutboxModule.forRoot() in the application module, " +
          "or set `outgoing: false` in a service that only receives them.",
      );
    }
    this.checkReceivers();
    this.storage[LOCK_STORAGE]();
  }

  /** Every `@VerifyWebhook(name)` names a configured receiver, and deduplication has an inbox. */
  private checkReceivers(): void {
    const used = new Map<string, string>();
    for (const wrapper of this.discovery.getControllers()) {
      const { metatype } = wrapper;
      if (!metatype || typeof metatype !== "function") {
        continue;
      }
      const onClass =
        MetadataRegistry.get<string>(VERIFY_WEBHOOK_METADATA, metatype) ??
        (Reflect.getMetadata(VERIFY_WEBHOOK_METADATA, metatype) as
          | string
          | undefined);
      if (onClass) {
        used.set(onClass, metatype.name);
      }
      const proto = metatype.prototype as Record<string, unknown> | undefined;
      if (!proto) {
        continue;
      }
      for (const method of this.scanner.getAllMethodNames(proto)) {
        const fn = proto[method];
        if (typeof fn !== "function") {
          continue;
        }
        const name =
          MetadataRegistry.get<string>(VERIFY_WEBHOOK_METADATA, fn) ??
          (Reflect.getMetadata(VERIFY_WEBHOOK_METADATA, fn) as
            | string
            | undefined);
        if (name) {
          used.set(name, `${metatype.name}.${method}`);
        }
      }
    }
    const known = [...this.config.receivers.keys()];
    for (const [name, where] of used) {
      const receiver = this.config.receivers.get(name);
      if (!receiver) {
        throw new Error(
          `${where}: @VerifyWebhook('${name}') names no receiver. Configured in WebhooksModule \`receivers\`: ${known.join(", ") || "none"}.`,
        );
      }
      if (receiver.dedupe && !this.inbox) {
        throw new Error(
          `${where}: receiver "${name}" deduplicates webhook ids with OutboxInbox, from @bunest/outbox: import OutboxModule.forRoot() ` +
            "(relay: { enabled: false } in a service that only receives), or set `dedupe: false` on the receiver.",
        );
      }
    }
  }
}

/** The providers `outgoing` and `transport` decide, added to the module `forRoot()`/`forRootAsync()` built. */
function withStructure(
  module: DynamicModule,
  structure: WebhooksModuleStructure,
): DynamicModule {
  const outgoing = structure.outgoing !== false;
  const providers: Provider[] = [
    { provide: WEBHOOKS_STRUCTURE, useValue: { outgoing } },
  ];
  const exportsList: ModuleExport[] = [];
  if (outgoing) {
    providers.push(
      ...transportProviders(structure.transport),
      WebhookWorker,
      WebhookFanOut,
      Webhooks,
      WebhookEndpoints,
      WebhookDeliveries,
    );
    exportsList.push(
      WebhookTransport,
      WebhookWorker,
      Webhooks,
      WebhookEndpoints,
      WebhookDeliveries,
    );
  } else if (structure.transport !== undefined) {
    throw new Error(
      "WebhooksModule: `transport` sends webhooks, and `outgoing: false` sends none. Remove one of them.",
    );
  }
  return {
    ...module,
    providers: [...(module.providers ?? []), ...providers],
    exports: [...(module.exports ?? []), ...exportsList],
  };
}

function transportProviders(
  top: Type<WebhookTransport> | WebhookTransport | undefined,
): Provider[] {
  if (typeof top === "function") {
    return [
      top,
      {
        provide: WebhookTransport,
        inject: [WEBHOOKS_MODULE_OPTIONS, top],
        useFactory: (
          options: WebhooksModuleOptions | undefined,
          instance: WebhookTransport,
        ) => {
          if (options?.transport !== undefined) {
            throw setTwice();
          }
          return instance;
        },
      },
    ];
  }
  if (top !== undefined && typeof top?.send !== "function") {
    throw new TypeError(
      "WebhooksModule: `transport` must be a WebhookTransport class or an object with send()",
    );
  }
  return [
    {
      provide: WebhookTransport,
      inject: [WEBHOOKS_MODULE_OPTIONS],
      useFactory: (options?: WebhooksModuleOptions) => {
        const fromFactory = options?.transport;
        if (top !== undefined && fromFactory !== undefined) {
          throw setTwice();
        }
        if (fromFactory !== undefined) {
          if (typeof fromFactory === "function") {
            throw new Error(
              `WebhooksModule: the forRootAsync() factory returned a class as \`transport\` (${(fromFactory as Function).name}). ` +
                "Classes go at the top level of forRootAsync(), where DI instantiates them; the factory returns instances.",
            );
          }
          if (typeof fromFactory.send !== "function") {
            throw new TypeError(
              "WebhooksModule: `transport` returned by the forRootAsync() factory must be a WebhookTransport instance",
            );
          }
          return fromFactory;
        }
        return top ?? new HttpWebhookTransport(options?.delivery ?? {});
      },
    },
  ];
}

function setTwice(): Error {
  return new Error(
    "WebhooksModule: `transport` is set both at the top level and in the options the factory returns. Set it in one place.",
  );
}
