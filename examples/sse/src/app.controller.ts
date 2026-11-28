import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Sse,
  SseSignal,
  type MessageEvent,
} from "@bunest/core";
import {
  NotificationsService,
  type NotificationPayload,
} from "./notifications.service";

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Bunest SSE Demo</title>
  </head>
  <body>
    <h1>Bunest Server-Sent Events</h1>
    <ul id="events"></ul>
    <script>
      const source = new EventSource("/sse?count=5&intervalMs=500");
      source.addEventListener("tick", (e) => {
        const li = document.createElement("li");
        li.textContent = e.data;
        document.getElementById("events").appendChild(li);
      });
    </script>
  </body>
</html>`;

@Controller()
export class AppController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Header("Content-Type", "text/html; charset=utf-8")
  index(): string {
    return INDEX_HTML;
  }

  @Sse("sse")
  async *sse(
    @SseSignal() signal: AbortSignal,
    @Query("count") countParam?: string,
    @Query("intervalMs") intervalParam?: string,
  ): AsyncGenerator<MessageEvent> {
    const count = Math.max(1, Number(countParam ?? 3));
    const intervalMs = Math.max(0, Number(intervalParam ?? 1000));

    for (let i = 1; i <= count; i++) {
      if (signal.aborted) break;
      yield {
        id: String(i),
        type: "tick",
        retry: 3000,
        data: { hello: "world", seq: i },
      };
      if (i < count && intervalMs > 0) {
        await Bun.sleep(intervalMs);
      }
    }
  }

  @Sse("notifications")
  streamNotifications(
    @SseSignal() signal: AbortSignal,
    @Query("limit") limitParam?: string,
  ): AsyncGenerator<MessageEvent> {
    const limit = limitParam ? Number(limitParam) : undefined;
    return this.notifications.subscribe(signal, limit);
  }

  @Post("notifications")
  pushNotification(
    @Body() body: { message: string },
  ): NotificationPayload {
    return this.notifications.publish(body.message);
  }
}
