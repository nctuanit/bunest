import {
  OnQueueEvent,
  QueueEventsHost,
  QueueEventsListener,
} from "@bunest/jobs/queues";

export interface AudioQueueEventRecord {
  readonly event: "added" | "completed" | "failed";
  readonly jobId: string;
  readonly detail: unknown;
}

@QueueEventsListener("audio")
export class AudioEventsListener extends QueueEventsHost {
  public readonly events: AudioQueueEventRecord[] = [];

  @OnQueueEvent("added")
  onAdded(args: { jobId: string; name: string }): void {
    this.events.push({ event: "added", jobId: args.jobId, detail: args.name });
  }

  @OnQueueEvent("completed")
  onCompleted(args: { jobId: string; returnvalue: unknown }): void {
    this.events.push({
      event: "completed",
      jobId: args.jobId,
      detail: args.returnvalue,
    });
  }

  @OnQueueEvent("failed")
  onFailed(args: { jobId: string; failedReason: string }): void {
    this.events.push({
      event: "failed",
      jobId: args.jobId,
      detail: args.failedReason,
    });
  }
}
