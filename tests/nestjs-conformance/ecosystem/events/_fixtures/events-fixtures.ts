import "reflect-metadata";
import {
  Controller,
  Inject,
  Injectable,
  Module,
  Scope,
  SetMetadata,
  type OnApplicationBootstrap,
  type Provider,
} from "../../../../../packages/common/src";
import {
  EVENT_LISTENER_METADATA,
  EVENT_PAYLOAD,
  EventEmitter2,
  EventEmitterModule,
  OnEvent,
  type OnEventMetadata,
  type OnEventOptions,
} from "../../../../../packages/events/src";

export const TEST_EVENT_PAYLOAD = {
  test: "event",
};

export const TEST_EVENT_MULTIPLE_PAYLOAD = [
  TEST_EVENT_PAYLOAD,
  {
    test2: "event2",
  },
];

export const TEST_EVENT_STRING_PAYLOAD = "some-string";

export const CUSTOM_DECORATOR_EVENT = "custom-decorator-event";

export const TEST_PROVIDER_TOKEN = "TEST_PROVIDER";

export const TestProvider: Provider = {
  provide: TEST_PROVIDER_TOKEN,
  useFactory: () => {
    const testProvidedValue = {
      a: 5,
      b: 7,
    };
    return testProvidedValue;
  },
};

export const CustomEvent = (event: string, options?: OnEventOptions) =>
  SetMetadata(EVENT_LISTENER_METADATA, {
    event,
    options,
  } as unknown as OnEventMetadata);

@Injectable()
export class CustomEventDecoratorConsumer {
  public isEmitted = false;

  @CustomEvent(CUSTOM_DECORATOR_EVENT)
  handleCustomEvent() {
    this.isEmitted = true;
  }
}

@Controller()
export class EventsControllerConsumer {
  public eventPayload: Record<string, any> = {};

  @OnEvent("test.*")
  onTestEvent(payload: Record<string, any>) {
    this.eventPayload = payload;
  }
}

@Injectable()
export class EventsProviderAliasedConsumer {
  private _eventPayload: Record<string, any> = {};
  public setEventPayloadCalls = 0;

  set eventPayload(value: Record<string, any>) {
    this.setEventPayloadCalls += 1;
    this._eventPayload = value;
  }

  get eventPayload(): Record<string, any> {
    return this._eventPayload;
  }

  @OnEvent("test.*")
  onTestEvent(payload: Record<string, any>) {
    this.eventPayload = payload;
  }
}

@Injectable()
export class EventsProviderPrependConsumer {
  public eventPayload: Record<string, any> = {};

  @OnEvent("test.*", { prependListener: true })
  onTestEvent(payload: Record<string, any>) {
    this.eventPayload = payload;
  }
}

@Injectable()
export class EventsProviderPriorityConsumer {
  public calls: string[] = [];

  @OnEvent("priority.event", { priority: -1 })
  negative() {
    this.calls.push("negative");
  }

  @OnEvent("priority.event")
  normal() {
    this.calls.push("normal");
  }

  @OnEvent("priority.event", { priority: 10 })
  high() {
    this.calls.push("high");
  }
}

@Injectable()
export class EventsProviderConsumer {
  public eventPayload: Record<string, any> = {};
  public stackedEventCalls = 0;
  public errorHandlingCalls = 0;

  @OnEvent("test.*")
  onTestEvent(payload: Record<string, any>) {
    this.eventPayload = payload;
  }

  @OnEvent("stacked1.*")
  @OnEvent("stacked2.*")
  onStackedEvent() {
    this.stackedEventCalls++;
  }

  @OnEvent("error-handling.provider")
  onErrorHandlingEvent() {
    this.errorHandlingCalls++;
    throw new Error("This is a test error");
  }

  @OnEvent("error-handling-suppressed.provider", { suppressErrors: true })
  onErrorHandlingSuppressedEvent() {
    this.errorHandlingCalls++;
    throw new Error("This is a test error");
  }

  @OnEvent("error-throwing.provider", { suppressErrors: false })
  onErrorThrowingEvent() {
    throw new Error("This is a test error");
  }
}

export class RequestScopedEventPayload {
  public objectValue: Record<string, any>;
  public arrayValue: any[];
  public stringValue: string;

  constructor() {
    this.objectValue = {};
    this.arrayValue = [];
    this.stringValue = "";
  }

  public setPayload(value: any) {
    if (Array.isArray(value)) {
      this.arrayValue = value;
    } else if (typeof value === "string") {
      this.stringValue = value;
    } else {
      this.objectValue = value;
    }
  }
}

// ADR-012: Bunest requires explicit `{ scope: Scope.REQUEST }` on providers injecting `EVENT_PAYLOAD`/`REQUEST`
@Injectable({ scope: Scope.REQUEST })
export class EventsProviderRequestScopedConsumer {
  constructor(@Inject(EVENT_PAYLOAD) public eventRef: any) {
    EventsProviderRequestScopedConsumer.injectedEventPayload.setPayload(
      this.eventRef,
    );
  }

  public static injectedEventPayload = new RequestScopedEventPayload();

  @OnEvent("test.*")
  onTestEvent() {}

  @OnEvent("multiple.*")
  onMultiplePayloadEvent() {}

  @OnEvent("string.*")
  onStringPayloadEvent() {}

  @OnEvent("error-handling.request-scoped")
  onErrorHandlingEvent() {
    throw new Error("This is a test error");
  }

  @OnEvent("error-handling-suppressed.request-scoped", { suppressErrors: true })
  onErrorHandlingSuppressedEvent() {
    throw new Error("This is a test error");
  }

  @OnEvent("error-throwing.request-scoped", { suppressErrors: false })
  onErrorThrowingEvent() {
    throw new Error("This is a test error");
  }

  @OnEvent("not-durable")
  onDurableTest() {
    return this;
  }
}

@Injectable({ scope: Scope.REQUEST, durable: true })
export class EventsProviderDurableRequestScopedConsumer {
  constructor(@Inject(EVENT_PAYLOAD) public eventRef: any) {}

  public static injectedEventPayload = new RequestScopedEventPayload();

  private transformPayload = (payload: unknown[]) =>
    payload.length === 1 ? payload[0] : payload;

  @OnEvent("test.*")
  onTestEvent(...payload: unknown[]) {
    EventsProviderDurableRequestScopedConsumer.injectedEventPayload.setPayload(
      this.transformPayload(payload),
    );
  }

  @OnEvent("multiple.*")
  onMultiplePayloadEvent(...payload: unknown[]) {
    EventsProviderDurableRequestScopedConsumer.injectedEventPayload.setPayload(
      this.transformPayload(payload),
    );
  }

  @OnEvent("string.*")
  onStringPayloadEvent(payload: string) {
    EventsProviderDurableRequestScopedConsumer.injectedEventPayload.setPayload(
      payload,
    );
  }

  @OnEvent("error-handling.durable-request-scoped")
  onErrorHandlingEvent() {
    throw new Error("This is a test error");
  }

  @OnEvent("error-handling-suppressed.durable-request-scoped", {
    suppressErrors: true,
  })
  onErrorHandlingSuppressedEvent() {
    throw new Error("This is a test error");
  }

  @OnEvent("error-throwing.durable-request-scoped", { suppressErrors: false })
  onErrorThrowingEvent() {
    throw new Error("This is a test error");
  }

  @OnEvent("durable")
  onDurableTest() {
    return this;
  }
}

@Injectable({ scope: Scope.REQUEST })
export class FailingRequestScopedDependency {
  constructor() {
    throw new Error("This is a test instantiation error");
  }
}

@Injectable({ scope: Scope.REQUEST })
export class EventsProviderRequestScopedFailingConsumer {
  constructor(private readonly dependency: FailingRequestScopedDependency) {}

  @OnEvent("instantiation-error-handling-suppressed.request-scoped")
  onSuppressedEvent() {
    return this.dependency;
  }

  @OnEvent("instantiation-error-throwing.request-scoped", {
    suppressErrors: false,
  })
  onThrowingEvent() {
    return this.dependency;
  }
}

@Injectable()
export class EventsProducer implements OnApplicationBootstrap {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  onApplicationBootstrap() {
    this.eventEmitter.emit("test.event", TEST_EVENT_PAYLOAD);
    this.eventEmitter.emit("multiple.event", TEST_EVENT_MULTIPLE_PAYLOAD);
    this.eventEmitter.emit("string.event", TEST_EVENT_STRING_PAYLOAD);
    this.eventEmitter.emit("stacked1.event", TEST_EVENT_PAYLOAD);
    this.eventEmitter.emit("stacked2.event", TEST_EVENT_PAYLOAD);
    this.eventEmitter.emit("priority.event", TEST_EVENT_PAYLOAD);
  }
}

@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
    }),
  ],
  controllers: [EventsControllerConsumer],
  providers: [
    EventsProviderConsumer,
    EventsProviderPrependConsumer,
    EventsProviderPriorityConsumer,
    EventsProducer,
    TestProvider,
    EventsProviderRequestScopedConsumer,
    FailingRequestScopedDependency,
    EventsProviderRequestScopedFailingConsumer,
    EventsProviderDurableRequestScopedConsumer,
    EventsProviderAliasedConsumer,
    {
      provide: "AnAliasedConsumer",
      useExisting: EventsProviderAliasedConsumer,
    },
    CustomEventDecoratorConsumer,
  ],
})
export class EventsAppModule {}
