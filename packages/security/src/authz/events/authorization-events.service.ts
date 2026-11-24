import { Injectable, type OnApplicationShutdown } from "@bunest/core";
import { deniedChannel } from "./authorization.channels";
import type { AuthorizationEvent } from "./authorization-events.interface";
import { EventChannel, type EventStream } from "./event-channel";

/**
 * The app's denials, for an audit log or metrics. Each event is also
 * published on the `nestjs:authorization:denied` diagnostics channel, for
 * tooling that runs outside Bunest/Nest.
 */
@Injectable()
export class AuthorizationEvents implements OnApplicationShutdown {
  private readonly subject = new EventChannel<AuthorizationEvent>();
  /** Every denial of this application, in order (zero-RxJS Subscribable & AsyncIterable). */
  readonly events$: EventStream<AuthorizationEvent> = this.subject.asStream();

  /** @internal Called by the guard and `AuthorizationService`. */
  emit(event: AuthorizationEvent): void {
    if (deniedChannel.hasSubscribers) {
      deniedChannel.publish(event);
    }
    this.subject.next(event);
  }

  onApplicationShutdown(): void {
    this.subject.complete();
  }
}
