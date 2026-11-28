import { Body, Controller, Get, NotFoundException, Param, Post } from "@bunest/core";
import { InjectQueue, Queue } from "@bunest/jobs/queues";
import { AudioEventsListener } from "./audio-events.listener";
import {
  AudioProcessor,
  type TranscodeJobData,
  type TranscodeResult,
} from "./audio.processor";

@Controller("audio")
export class AudioController {
  constructor(
    @InjectQueue("audio")
    private readonly audioQueue: Queue<TranscodeJobData, TranscodeResult>,
    private readonly processor: AudioProcessor,
    private readonly listener: AudioEventsListener,
  ) {}

  @Post("transcode")
  async transcode(@Body() body: TranscodeJobData) {
    const job = await this.audioQueue.add("transcode", {
      file: body.file ?? "sample.wav",
      format: body.format ?? "mp3",
    });
    return {
      jobId: job.id,
      name: job.name,
      data: job.data,
    };
  }

  @Get("jobs/:id")
  async getJob(@Param("id") id: string) {
    const job = await this.audioQueue.getJob(id);
    if (!job) {
      throw new NotFoundException(`Job "${id}" not found`);
    }
    return {
      id: job.id,
      name: job.name,
      status: job.status,
      data: job.data,
      result: job.returnValue ?? null,
      failedReason: job.failedReason ?? null,
    };
  }

  @Get("stats")
  async getStats() {
    const counts = await this.audioQueue.getCounts();
    return {
      counts,
      workerEvents: [...this.processor.workerEvents],
      queueEvents: [...this.listener.events],
    };
  }
}
