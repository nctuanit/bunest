import { Injectable, type OnApplicationShutdown } from "@bunest/core";
import { EventSubject, type ReactiveStream } from "../utils/reactive.util";
import type { ResilienceEvent } from "./resilience-events.interface";

/**
 * The application's resilience events: every event from the policies it
 * created (decorators, presets, `ResilienceService.create()`). The same
 * events go to the `nestjs:resilience:<type>` diagnostics channels, which
 * also carry events of policies created with `new`. `events$` completes when
 * the application shuts down.
 */
@Injectable()
export class ResilienceEvents implements OnApplicationShutdown {
  private readonly subject = new EventSubject<ResilienceEvent>();
  readonly events$: ReactiveStream<ResilienceEvent> = this.subject.asStream();

  /** @internal The sink attached to module-created policies. */
  readonly emit = (event: ResilienceEvent): void => {
    this.subject.next(event);
  };

  onApplicationShutdown(): void {
    this.subject.complete();
  }
}
