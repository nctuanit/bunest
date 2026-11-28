import { Injectable, type MessageEvent } from "@bunest/core";

export interface NotificationPayload {
  readonly id: string;
  readonly message: string;
  readonly sentAt: string;
}

type Subscriber = (event: NotificationPayload) => void;

@Injectable()
export class NotificationsService {
  private readonly subscribers = new Set<Subscriber>();
  private seq = 0;

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  publish(message: string): NotificationPayload {
    const event: NotificationPayload = {
      id: String(++this.seq),
      message,
      sentAt: new Date().toISOString(),
    };
    for (const sub of this.subscribers) {
      sub(event);
    }
    return event;
  }

  async *subscribe(
    signal: AbortSignal,
    maxEvents?: number,
  ): AsyncGenerator<MessageEvent> {
    const queue: NotificationPayload[] = [];
    let notify: (() => void) | null = null;

    const listener: Subscriber = (event) => {
      queue.push(event);
      if (notify) {
        const wake = notify;
        notify = null;
        wake();
      }
    };

    const onAbort = () => {
      if (notify) {
        const wake = notify;
        notify = null;
        wake();
      }
    };

    this.subscribers.add(listener);
    signal.addEventListener("abort", onAbort, { once: true });

    let emitted = 0;
    try {
      while (!signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          continue;
        }
        const next = queue.shift()!;
        yield {
          id: next.id,
          type: "notification",
          data: next,
        };
        emitted += 1;
        if (maxEvents !== undefined && emitted >= maxEvents) {
          break;
        }
      }
    } finally {
      this.subscribers.delete(listener);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
