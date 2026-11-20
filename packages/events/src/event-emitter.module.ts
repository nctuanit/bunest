import { Module, type DynamicModule } from "@bunest/common";
import { EVENT_EMITTER_OPTIONS } from "./constants";
import { EmitEventAspect } from "./decorators/emit-event.decorator";
import { EventEmitterReadinessWatcher } from "./event-emitter-readiness.watcher";
import { EventEmitterExplorer } from "./event-emitter.explorer";
import { EventEmitterService } from "./event-emitter.service";
import type { EventEmitterModuleOptions } from "./interfaces/event-emitter.interface";

@Module({})
export class EventEmitterModule {
  static forRoot(options: EventEmitterModuleOptions = {}): DynamicModule {
    return {
      module: EventEmitterModule,
      global: options.global ?? true,
      providers: [
        {
          provide: EVENT_EMITTER_OPTIONS,
          useValue: { ...options },
        },
        EventEmitterService,
        EventEmitterReadinessWatcher,
        EventEmitterExplorer,
        EmitEventAspect,
      ],
      exports: [
        EVENT_EMITTER_OPTIONS,
        EventEmitterService,
        EventEmitterReadinessWatcher,
        EmitEventAspect,
      ],
    };
  }
}
