# @bunest/ai

Language models for Bunest: model calls with timeouts, retries and fallbacks, structured output, embeddings, tools and agents, streaming, and durable workflows.

## Features

- **Model Calls** — `generateText()`, `generateObject()`, and `streamText()` with timeouts, retries, fallbacks, and token/cost budgets.
- **Embeddings** — `embed()` and `embedMany()` with resilience policies and usage events.
- **Agent Functions** — `@AgentFunction()` decorator with full Bunest execution pipeline support (guards, interceptors, pipes, and exception filters).
- **Streaming** — `AiTextStream` supporting UI message streams and plain text streams.
- **Structured Output** — Standard Schema v1 and JSON Schema validation for typed model responses.
- **Testing Utilities** — `@bunest/ai/testing` exports `FakeModel`, `FakeEmbeddingModel`, `overrideModels()`, `overrideEmbeddingModels()`, and `callTool()`.
- **Durable Workflows** — `@bunest/ai/workflows` runs agent loops as durable workflows on `@bunest/workflows` with human-in-the-loop tool approval.

## Installation

```bash
bun add @bunest/ai
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import { AiModule, AiService } from "@bunest/ai";

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

@Injectable()
export class SummaryService {
  constructor(private readonly ai: AiService) {}

  async summarize(text: string) {
    const { text: summary } = await this.ai.generateText({
      prompt: `Summarize: ${text}`,
    });
    return summary;
  }
}
```

## Key Exports

- **Module & Options**: `AiModule` (`forRoot`, `forRootAsync`), `AI_MODULE_OPTIONS`, `DEFAULT_MODEL_NAME`, `getModelToken`, `getEmbeddingModelToken`, `describeModel`
- **Services & Streaming**: `AiService`, `AiModels`, `AiEmbeddingModels`, `AiTools`, `AiTextStream`, `AiExecutionContext`
- **Decorators**: `@AgentFunction()`, `@InjectModel()`, `@InjectEmbeddingModel()`
- **Errors**: `AiError`, `AiConfigurationError`, `AiModelError`, `AiOutputError`, `AiToolError`, `AiBudgetExceededError`

## Subpath Exports

- **`@bunest/ai/testing`**: `FakeModel`, `fakeModel`, `providerError`, `FakeEmbeddingModel`, `fakeEmbeddingModel`, `overrideModels`, `overrideEmbeddingModels`, `callTool`
- **`@bunest/ai/workflows`**: `AiWorkflowsModule`, `AiAgents`, `TOOL_APPROVAL`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
