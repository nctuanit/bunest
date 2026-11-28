import { Module } from "@bunest/core";
import { BullModule } from "@bunest/jobs/queues";
import { AudioModule } from "./audio/audio.module";

@Module({
  imports: [
    BullModule.forRoot({
      prefix: "bunest-audio",
      defaultJobOptions: { attempts: 1 },
    }),
    AudioModule,
  ],
})
export class AppModule {}
