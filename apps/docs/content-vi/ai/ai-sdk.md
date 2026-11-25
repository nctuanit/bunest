# AI SDK

**`@bunest/ai`** mang khả năng tích hợp LLM native vào Bunest không dependency runtime bên ngoài—với các SSE client `fetch()` native cho **OpenAI**, **Anthropic** và **Google Gemini**, kiểm tra đầu ra có cấu trúc qua Standard Schema v1, embedding, công cụ `@AgentFunction()` kèm đầy đủ pipeline guard/pipe/interceptor/filter, retry/fallback/ngân sách token, test double (`@bunest/ai/testing`) và vòng lặp agent bền bỉ (`@bunest/ai/workflows`).

## Cài đặt

```bash
bun add @bunest/ai
```

## Thiết lập Module

Đăng ký `AiModule.forRoot()` với một hoặc nhiều mô hình ngôn ngữ hoặc embedding được đặt tên:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { AiModule } from "@bunest/ai";

@Module({
  imports: [
    AiModule.forRoot({
      models: {
        default: myLanguageModel,
      },
    }),
  ],
})
export class AppModule {}
```

## Tạo văn bản, đầu ra có cấu trúc & Streaming

Inject `AiService` để dùng `generateText()`, `generateObject()`, `streamText()`, `embed()` và `embedMany()`:

@@filename(assistant.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { AiService } from "@bunest/ai";

@Injectable()
export class AssistantService {
  constructor(private readonly ai: AiService) {}

  async summarize(text: string) {
    const { text: summary } = await this.ai.generateText({
      prompt: `Summarize concisely:\n\n${text}`,
    });
    return summary;
  }
}
```

## Agent Function (`@AgentFunction`)

Phơi bày các phương thức có định kiểu được DI quản lý thành công cụ để agent gọi, hỗ trợ đầy đủ các enhancer của Bunest (`@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters`):

@@filename(weather.tools.ts)

```ts
import { Injectable } from "@bunest/core";
import { AgentFunction } from "@bunest/ai";

@Injectable()
export class WeatherTools {
  @AgentFunction({
    name: "get_weather",
    description: "Get current weather for a city",
  })
  async getWeather(input: { city: string }) {
    return { city: input.city, tempC: 24, condition: "sunny" };
  }
}
```

## Subpath Export

- **`@bunest/ai/testing`** — `FakeModel`, `FakeEmbeddingModel`, `overrideModels()` và `callTool()` cho unit test offline tất định.
- **`@bunest/ai/workflows`** — Vòng lặp thực thi agent bền bỉ xây dựng trên [`@bunest/workflows`](/distributed/workflows) hỗ trợ phê duyệt công cụ thủ công (human-in-the-loop).
