import { Injectable, type OnApplicationShutdown } from "@bunest/common";
import { channelFor } from "./authentication.channels";
import type { AuthenticationEvent } from "./authentication-events.interface";
import { EventChannel, type EventStream } from "./event-channel";

/**
 * The audit trail of sign-ins, sign-outs, second-factor changes, password
 * resets, email verifications, refused magic links, and failed session touches.
 */
@Injectable()
export class AuthenticationEvents implements OnApplicationShutdown {
  private readonly subject = new EventChannel<AuthenticationEvent>();
  /** Every event of this application, in order (zero-RxJS Subscribable & AsyncIterable). */
  readonly events$: EventStream<AuthenticationEvent> = this.subject.asStream();

  /** @internal Called by the module's services. */
  emit(event: AuthenticationEvent): void {
    const target = channelFor(event.type);
    if (target.hasSubscribers) {
      target.publish(event);
    }
    this.subject.next(event);
  }

  onApplicationShutdown(): void {
    this.subject.complete();
  }
}
