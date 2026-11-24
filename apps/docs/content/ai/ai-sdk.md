# AI SDK

**`@bunest/ai`** brings native LLM integration to Bunest with zero external runtime dependencies—featuring native `fetch()` SSE clients for **OpenAI**, **Anthropic**, and **Google Gemini**, structured output validation via Standard Schema v1, embeddings, `@AgentFunction()` tools with full guard/pipe/interceptor/filter pipelines, retries/fallbacks/token budgets, testing doubles (`@bunest/ai/testing`), and durable agent loops (`@bunest/ai/workflows`).

## Installation

```bash
bun add @bunest/ai
```

## Module Setup

Register `AiModule.forRoot()` with one or more named language or embedding models:

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

## Text Generation, Structured Output & Streaming

Inject `AiService` for `generateText()`, `generateObject()`, `streamText()`, `embed()`, and `embedMany()`:

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

## Agent Functions (`@AgentFunction`)

Expose typed DI-managed methods as callable agent tools with full Bunest enhancer support (`@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters`):

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

## Subpath Exports

- **`@bunest/ai/testing`** — `FakeModel`, `FakeEmbeddingModel`, `overrideModels()`, and `callTool()` for deterministic offline unit tests.
- **`@bunest/ai/workflows`** — Durable agent execution loops built on [`@bunest/workflows`](/distributed/workflows) with human-in-the-loop tool approval.
