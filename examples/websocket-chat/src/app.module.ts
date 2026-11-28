import { Module } from "@bunest/core";
import { WebSocketModule } from "@bunest/core/ws";
import { ChatGateway } from "./chat.gateway";

@Module({
  imports: [WebSocketModule.forRoot()],
  providers: [ChatGateway],
})
export class AppModule {}
