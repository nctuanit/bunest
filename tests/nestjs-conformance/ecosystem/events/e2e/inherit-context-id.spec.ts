import "reflect-metadata";
import { afterEach, expect, it, mock, spyOn } from "bun:test";
import {
  Controller,
  Inject,
  Injectable,
  REQUEST,
  Scope,
} from "../../../../../packages/common/src";
import {
  ContextIdFactory,
  createContextId,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  EventEmitter2,
  EventEmitterModule,
  OnEvent,
} from "../../../../../packages/events/src";
import {
  Test,
  describeConformance,
  itAdapted,
} from "../../../_helpers";

@Injectable({ scope: Scope.REQUEST })
class RequestScopedListener {
  @OnEvent("inherit.test")
  onTest() {}
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedState {
  private static nextId = 1;

  static reset() {
    RequestScopedState.nextId = 1;
  }

  readonly id = RequestScopedState.nextId++;
}

@Injectable({ scope: Scope.REQUEST })
class InheritedContextListener {
  static records: Array<{
    listenerRequest: unknown;
    listenerStateId: number;
  }> = [];

  static reset() {
    InheritedContextListener.records = [];
  }

  constructor(
    @Inject(REQUEST) private readonly request: unknown,
    private readonly state: RequestScopedState,
  ) {}

  @OnEvent("inherit.http")
  onTest() {
    InheritedContextListener.records.push({
      listenerRequest: this.request,
      listenerStateId: this.state.id,
    });
  }
}

// ADR-012: Request-scoped controller must declare `{ scope: Scope.REQUEST }` explicitly
@Controller({ scope: Scope.REQUEST })
class InheritedContextController {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly state: RequestScopedState,
  ) {}

  async inherit(request: unknown) {
    await this.eventEmitter.emitAsync("inherit.http", request);
    return {
      controllerStateId: this.state.id,
      listenerStateId: InheritedContextListener.records[0]?.listenerStateId,
      sameRequest:
        InheritedContextListener.records[0]?.listenerRequest === request,
    };
  }
}

describeConformance(
  "EventEmitterModule - inheritRequestContextId",
  {
    upstreamPath: "nestjs/event-emitter/tests/e2e/inherit-context-id.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-012"],
    notes:
      "Uses native @bunest/events EventEmitter2, @bunest/common REQUEST token, explicit Scope.REQUEST on InheritedContextController (ADR-012), and ContextIdFactory.getByRequest() WeakMap association.",
  },
  () => {
    afterEach(() => {
      ContextIdFactory.reset();
    });

    async function createHttpApp(
      inheritRequestContextId: boolean,
    ): Promise<BunestApplication> {
      RequestScopedState.reset();
      InheritedContextListener.reset();

      const moduleRef = await Test.createTestingModule({
        imports: [EventEmitterModule.forRoot({ inheritRequestContextId })],
        controllers: [InheritedContextController],
        providers: [RequestScopedState, InheritedContextListener],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      return app;
    }

    async function callInRequestContext(app: BunestApplication) {
      const request = {};
      const contextId = ContextIdFactory.getByRequest(request);
      app.registerRequestByContextId(request, contextId);

      const controller = await app.resolve(
        InheritedContextController,
        contextId,
      );
      return controller.inherit(request);
    }

    it("default (false): wraps request in EventPayloadHost", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [EventEmitterModule.forRoot({})],
        providers: [RequestScopedListener],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();

      const spy = spyOn(ContextIdFactory, "getByRequest");
      try {
        const payload = { id: 1 };
        app.get(EventEmitter2).emit("inherit.test", payload);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]).toEqual({ payload });
      } finally {
        spy.mockRestore();
        await app.close();
      }
    });

    it("inheritRequestContextId=true: forwards original request directly", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          EventEmitterModule.forRoot({ inheritRequestContextId: true }),
        ],
        providers: [RequestScopedListener],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();

      const spy = spyOn(ContextIdFactory, "getByRequest");
      try {
        const payload = { id: 2 };
        app.get(EventEmitter2).emit("inherit.test", payload);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]).toBe(payload);
      } finally {
        spy.mockRestore();
        await app.close();
      }
    });

    it("inheritRequestContextId=true: passes original request to context id strategy", async () => {
      const sharedContextId = createContextId();
      const attachSpy = mock(
        (contextId: ReturnType<typeof createContextId>, _request: unknown) =>
          (info: { isTreeDurable: boolean }) =>
            info.isTreeDurable ? sharedContextId : contextId,
      );
      ContextIdFactory.apply({
        attach: attachSpy,
      });

      const moduleRef = await Test.createTestingModule({
        imports: [
          EventEmitterModule.forRoot({ inheritRequestContextId: true }),
        ],
        providers: [RequestScopedListener],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();

      try {
        const payload = { id: 3 };
        app.get(EventEmitter2).emit("inherit.test", payload);

        expect(attachSpy).toHaveBeenCalled();
        const request = attachSpy.mock.calls[0]?.[1];
        expect(request).toBe(payload);
      } finally {
        await app.close();
      }
    });

    itAdapted(
      "ADR-012",
      "default (false): creates a separate request-scoped listener context",
      async () => {
        const app = await createHttpApp(false);
        try {
          const result = await callInRequestContext(app);

          expect(result.sameRequest).toBe(true);
          expect(result.listenerStateId).not.toBe(result.controllerStateId);
        } finally {
          await app.close();
        }
      },
      "explicit Scope.REQUEST on controller + ContextIdFactory WeakMap binding",
    );

    itAdapted(
      "ADR-012",
      "inheritRequestContextId=true: reuses the originating request context",
      async () => {
        const app = await createHttpApp(true);
        try {
          const result = await callInRequestContext(app);

          expect(result.sameRequest).toBe(true);
          expect(result.listenerStateId).toBe(result.controllerStateId);
        } finally {
          await app.close();
        }
      },
      "explicit Scope.REQUEST on controller + ContextIdFactory WeakMap binding",
    );
  },
);
