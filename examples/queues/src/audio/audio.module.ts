import { Module } from "@bunest/core";
import { BullModule } from "@bunest/jobs/queues";
import { AudioController } from "./audio.controller";
import { AudioEventsListener } from "./audio-events.listener";
import { AudioProcessor } from "./audio.processor";

@Module({
  imports: [BullModule.registerQueue({ name: "audio" })],
  controllers: [AudioController],
  providers: [AudioProcessor, AudioEventsListener],
})
export class AudioModule {}
