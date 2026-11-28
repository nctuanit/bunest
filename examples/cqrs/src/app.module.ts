import { Module } from "@bunest/core";
import { CqrsModule } from "@bunest/messaging/cqrs";
import { HeroesGameModule } from "./heroes/heroes.module";

@Module({
  imports: [CqrsModule.forRoot({ global: true }), HeroesGameModule],
})
export class AppModule {}
