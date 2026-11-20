import { OutboxError } from "./outbox.error";

/**
 * No `@OnOutboxMessage` handler for the topic in this process. Retried (a rolling
 * deploy can put an old instance's relay in front of a new producer's message).
 */
export class OutboxNoHandlerError extends OutboxError {
  readonly topic: string;
  override name = "OutboxNoHandlerError";

  constructor(topic: string) {
    super(`No @OnOutboxMessage handler for topic "${topic}"`);
    this.topic = topic;
  }
}
