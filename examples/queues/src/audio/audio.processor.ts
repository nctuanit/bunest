import {
  OnWorkerEvent,
  Processor,
  WorkerHost,
  type Job,
} from "@bunest/jobs/queues";

export interface TranscodeJobData {
  readonly file: string;
  readonly format?: "mp3" | "ogg" | "flac";
}

export interface TranscodeResult {
  readonly outputFile: string;
  readonly format: string;
  readonly processedAt: string;
}

@Processor("audio", { concurrency: 2 })
export class AudioProcessor extends WorkerHost {
  public readonly workerEvents: string[] = [];

  async process(job: Job<TranscodeJobData>): Promise<TranscodeResult> {
    if (job.data.file.endsWith(".corrupt")) {
      throw new Error(`Cannot transcode corrupt file: ${job.data.file}`);
    }
    const format = job.data.format ?? "mp3";
    const baseName = job.data.file.replace(/\.[^.]+$/, "");
    return {
      outputFile: `${baseName}.${format}`,
      format,
      processedAt: new Date().toISOString(),
    };
  }

  @OnWorkerEvent("active")
  onActive(job: Job<TranscodeJobData>): void {
    this.workerEvents.push(`active:${job.name}:${job.data.file}`);
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<TranscodeJobData>, result: TranscodeResult): void {
    this.workerEvents.push(`completed:${job.name}:${result.outputFile}`);
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<TranscodeJobData>, err: Error): void {
    this.workerEvents.push(`failed:${job.name}:${err.message}`);
  }
}
