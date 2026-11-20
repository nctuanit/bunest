import type {
  AiStep,
  AiToolCall,
  AiToolResult,
} from '../interfaces/ai-result.interface';
import type { ModelMessage } from '../interfaces/ai-types.interface';
import { AiOutputError, AiToolError } from '../errors/ai.errors';
import { resolveLanguageModel } from '../providers/http-provider';
import type { ModelSchema } from '../utils/schema.util';
import { costOf, toUsage } from '../utils/usage.util';
import type { CallPlan } from './call-plan';
import type { StepAttempt } from './model-policy';

/** One model call's outcome. */
export interface StepOutcome {
  step: Omit<AiStep, 'attempts'>;
  responseMessages: ModelMessage[];
  output?: unknown;
  durationMs: number;
}

/** Structured output: the schema of the answer. */
export interface StepOutput {
  schema: ModelSchema<any>;
  name?: string;
  description?: string;
}

/** Whether the loop goes on after a step: the model asked for tools, and they ran. */
export function wantsAnotherStep(outcome: StepOutcome): boolean {
  return (
    outcome.step.finishReason === 'tool-calls' &&
    outcome.step.toolResults.length > 0
  );
}

function buildPrompt(plan: CallPlan, messages: ModelMessage[]): any[] {
  const prompt: any[] = [];
  if (plan.instructions !== undefined) {
    prompt.push({ role: 'system', content: plan.instructions });
  }
  for (const m of messages) {
    if (m.role === 'system') {
      prompt.push({
        role: 'system',
        content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
      });
    } else if (m.role === 'user') {
      prompt.push({
        role: 'user',
        content:
          typeof m.content === 'string'
            ? [{ type: 'text', text: m.content }]
            : m.content,
      });
    } else {
      prompt.push(m);
    }
  }
  return prompt;
}

function buildToolsSpec(plan: CallPlan): any[] | undefined {
  if (!plan.tools || Object.keys(plan.tools).length === 0) return undefined;
  return Object.entries(plan.tools).map(([name, tool]) => ({
    type: 'function' as const,
    name,
    ...(tool.description !== undefined && { description: tool.description }),
    inputSchema: tool.inputSchema?.jsonSchema ?? tool.parameters ?? { type: 'object', properties: {} },
    parameters: tool.inputSchema?.jsonSchema ?? tool.parameters ?? { type: 'object', properties: {} },
  }));
}

function parseToolInput(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw ?? {};
}

function buildToolResultMessage(results: AiToolResult[]): ModelMessage {
  return {
    role: 'tool',
    content: results.map((result) => ({
      type: 'tool-result',
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      output:
        result.error !== undefined
          ? { type: 'error-text', value: result.error }
          : typeof result.output === 'string'
            ? { type: 'text', value: result.output }
            : { type: 'json', value: result.output ?? null },
    })),
  };
}

async function executeToolCalls(
  plan: CallPlan,
  toolCalls: AiToolCall[],
  messages: ModelMessage[],
  attempt: StepAttempt,
  emit?: (chunk: Record<string, unknown>) => void,
): Promise<AiToolResult[]> {
  const toolResults: AiToolResult[] = [];
  if (toolCalls.length === 0 || !plan.tools) return toolResults;

  for (const tc of toolCalls) {
    emit?.({
      type: 'tool-input-available',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.input,
    });
    const tool = plan.tools[tc.toolName];
    if (!tool) {
      const error = `There is no tool named "${tc.toolName}"`;
      toolResults.push({ ...tc, error });
      emit?.({
        type: 'tool-output-error',
        toolCallId: tc.toolCallId,
        errorText: error,
      });
      continue;
    }
    if (typeof tool.execute !== 'function' && typeof tool !== 'function') {
      // Tool offered without execute (e.g. durable workflow callModel)
      continue;
    }
    try {
      let validatedInput = tc.input;
      if (tool.inputSchema?.validate) {
        const validation = await tool.inputSchema.validate(tc.input);
        if (!validation.success) {
          throw new AiToolError(
            `Invalid input: ${validation.error.message}`,
            tc.toolName,
          );
        }
        validatedInput = validation.value;
      }
      const output = await (typeof tool === 'function'
        ? tool(validatedInput)
        : tool.execute(validatedInput, {
            toolCallId: tc.toolCallId,
            messages,
            abortSignal: attempt.signal,
          }));
      toolResults.push({ ...tc, output });
      emit?.({
        type: 'tool-output-available',
        toolCallId: tc.toolCallId,
        output,
      });
    } catch (error) {
      const message =
        error instanceof AiToolError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      toolResults.push({ ...tc, error: message });
      emit?.({
        type: 'tool-output-error',
        toolCallId: tc.toolCallId,
        errorText: message,
      });
    }
  }
  return toolResults;
}

function buildAssistantMessage(text: string, toolCalls: AiToolCall[]): ModelMessage {
  const parts: any[] = [];
  if (text) {
    parts.push({ type: 'text', text });
  }
  for (const tc of toolCalls) {
    parts.push({
      type: 'tool-call',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.input,
    });
  }
  return {
    role: 'assistant',
    content: parts.length > 0 ? parts : text,
  };
}

/** One model call with `generateText()`: its tool calls run inside it. */
export async function generateStep(
  plan: CallPlan,
  index: number,
  messages: ModelMessage[],
  attempt: StepAttempt,
  output?: StepOutput,
): Promise<StepOutcome> {
  const started = performance.now();
  const modelObj = resolveLanguageModel(attempt.model.model);
  const settings = plan.settingsFor(attempt.model);
  const tools = buildToolsSpec(plan);
  const prompt = buildPrompt(plan, messages);

  plan.running = attempt;
  let result: any;
  try {
    result = await modelObj.doGenerate({
      inputFormat: 'messages',
      prompt,
      ...(tools && { tools }),
      ...(plan.toolChoice !== undefined && {
        toolChoice:
          typeof plan.toolChoice === 'string'
            ? { type: plan.toolChoice }
            : plan.toolChoice,
      }),
      ...(output && {
        responseFormat: {
          type: 'json',
          schema: output.schema.jsonSchema,
          ...(output.name !== undefined && { name: output.name }),
          ...(output.description !== undefined && {
            description: output.description,
          }),
        },
      }),
      mode: output
        ? {
            type: 'object-json' as const,
            schema: output.schema.jsonSchema,
            name: output.name,
            description: output.description,
          }
        : {
            type: 'regular' as const,
            ...(tools && { tools }),
            ...(plan.toolChoice !== undefined && {
              toolChoice:
                typeof plan.toolChoice === 'string'
                  ? { type: plan.toolChoice }
                  : plan.toolChoice,
            }),
          },
      ...settings,
      maxRetries: 0,
      abortSignal: attempt.signal,
    });
  } finally {
    // Keep plan.running active during tool execution below
  }

  let outcome: StepOutcome;
  try {
    const contentParts: any[] = Array.isArray(result.content)
      ? result.content
      : [];
    const text: string =
      typeof result.text === 'string'
        ? result.text
        : contentParts
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('');

    const rawToolCalls: any[] =
      result.toolCalls ??
      contentParts.filter((c) => c.type === 'tool-call');
    const toolCalls: AiToolCall[] = rawToolCalls.map((tc, i) => ({
      toolCallId: tc.toolCallId ?? tc.id ?? `call-${index}-${i + 1}`,
      toolName: tc.toolName ?? tc.name ?? '',
      input: parseToolInput(tc.input ?? tc.args),
    }));

    const finishReason: string =
      (typeof result.finishReason === 'object' && result.finishReason !== null
        ? result.finishReason.unified
        : result.finishReason) ?? (toolCalls.length > 0 ? 'tool-calls' : 'stop');

    const toolResults = await executeToolCalls(
      plan,
      toolCalls,
      messages,
      attempt,
    );

    const usage = toUsage(result.usage);
    const cost = costOf(usage, attempt.model.pricing);
    const responseMessages: ModelMessage[] = [
      buildAssistantMessage(text, toolCalls),
      ...(toolResults.length > 0 ? [buildToolResultMessage(toolResults)] : []),
    ];

    outcome = {
      step: {
        index,
        model: attempt.model.info,
        text,
        toolCalls,
        toolResults,
        finishReason,
        usage,
        ...(cost !== undefined && { cost }),
      },
      responseMessages,
      durationMs: performance.now() - started,
    };

    if (output && !wantsAnotherStep(outcome)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw toOutputError(error, text);
      }
      if (output.schema.validate) {
        const validation = await output.schema.validate(parsed);
        if (!validation.success) {
          throw toOutputError(validation.error, text);
        }
        outcome.output = validation.value;
      } else {
        outcome.output = parsed;
      }
    }
  } finally {
    plan.running = undefined;
  }

  return outcome;
}

function toOutputError(error: unknown, text: string): AiOutputError {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new AiOutputError(
    `The model's answer does not match the schema: ${msg}`,
    text,
    { cause: error },
  );
}

/**
 * One model call with `streamText()`, emitting UI message chunks as they come.
 * Holds `start` / `start-step` until the first content chunk arrives so pre-content failures can retry/fallback.
 */
export async function streamStep(
  plan: CallPlan,
  index: number,
  messages: ModelMessage[],
  attempt: StepAttempt,
): Promise<StepOutcome & { finish?: Record<string, unknown> }> {
  const emit = (chunk: Record<string, unknown>) => attempt.emit(chunk);
  plan.running = attempt;
  try {
    return await streamAttempt(plan, index, messages, attempt, emit);
  } finally {
    plan.running = undefined;
  }
}

async function streamAttempt(
  plan: CallPlan,
  index: number,
  messages: ModelMessage[],
  attempt: StepAttempt,
  emit: (chunk: Record<string, unknown>) => void,
): Promise<StepOutcome & { finish?: Record<string, unknown> }> {
  const started = performance.now();
  const modelObj = resolveLanguageModel(attempt.model.model);
  if (typeof modelObj.doStream !== 'function') {
    const out = await generateStep(plan, index, messages, attempt);
    if (index === 0) emit({ type: 'start' });
    emit({ type: 'start-step' });
    if (out.step.text) {
      emit({ type: 'text-start', id: `text-${index}` });
      emit({ type: 'text-delta', id: `text-${index}`, delta: out.step.text });
      emit({ type: 'text-end', id: `text-${index}` });
    }
    emit({ type: 'finish-step' });
    return {
      ...out,
      finish: { type: 'finish', finishReason: out.step.finishReason },
    };
  }

  const settings = plan.settingsFor(attempt.model);
  const tools = buildToolsSpec(plan);
  const prompt = buildPrompt(plan, messages);

  const streamResult = await modelObj.doStream({
    inputFormat: 'messages',
    prompt,
    ...(tools && { tools }),
    ...(plan.toolChoice !== undefined && {
      toolChoice:
        typeof plan.toolChoice === 'string'
          ? { type: plan.toolChoice }
          : plan.toolChoice,
    }),
    mode: {
      type: 'regular' as const,
      ...(tools && { tools }),
      ...(plan.toolChoice !== undefined && {
        toolChoice:
          typeof plan.toolChoice === 'string'
            ? { type: plan.toolChoice }
            : plan.toolChoice,
      }),
    },
    ...settings,
    maxRetries: 0,
    abortSignal: attempt.signal,
  });

  const held: Array<Record<string, unknown>> = [];
  if (index === 0) {
    held.push({ type: 'start' });
  }
  held.push({ type: 'start-step' });

  let opened = false;
  const flushHeld = () => {
    if (!opened) {
      opened = true;
      for (const h of held.splice(0)) emit(h);
    }
  };
  const emitContent = (chunk: Record<string, unknown>) => {
    flushHeld();
    emit(chunk);
  };

  let text = '';
  const toolCalls: AiToolCall[] = [];
  let rawUsage: any;
  let finishReason = 'stop';
  let textStarted = false;

  const stream = streamResult.stream;
  const consumeChunk = (part: any) => {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'error') {
      throw part.error ?? new Error(part.errorText ?? 'Stream error');
    }
    if (part.type === 'abort') {
      attempt.signal.throwIfAborted();
      return;
    }
    if (part.type === 'text-start') {
      textStarted = true;
      emitContent({ type: 'text-start', id: part.id ?? `text-${index}` });
    } else if (part.type === 'text-delta') {
      const delta: string = part.delta ?? part.textDelta ?? '';
      if (!textStarted) {
        textStarted = true;
        emitContent({ type: 'text-start', id: part.id ?? `text-${index}` });
      }
      text += delta;
      emitContent({
        type: 'text-delta',
        id: part.id ?? `text-${index}`,
        delta,
      });
    } else if (part.type === 'text-end') {
      if (textStarted) {
        textStarted = false;
        emitContent({ type: 'text-end', id: part.id ?? `text-${index}` });
      }
    } else if (part.type === 'tool-call') {
      const tc: AiToolCall = {
        toolCallId: part.toolCallId ?? part.id ?? `call-${index}-${toolCalls.length + 1}`,
        toolName: part.toolName ?? part.name ?? '',
        input: parseToolInput(part.input ?? part.args),
      };
      toolCalls.push(tc);
    } else if (part.type === 'finish') {
      finishReason =
        (typeof part.finishReason === 'object' && part.finishReason !== null
          ? part.finishReason.unified
          : part.finishReason) ?? finishReason;
      rawUsage = part.usage;
    }
  };

  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeChunk(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (stream && Symbol.asyncIterator in stream) {
    for await (const part of stream as AsyncIterable<any>) {
      consumeChunk(part);
    }
  }

  attempt.signal.throwIfAborted();
  if (textStarted) {
    emitContent({ type: 'text-end', id: `text-${index}` });
  }
  if (!opened) {
    flushHeld();
  }

  if (toolCalls.length > 0 && finishReason === 'stop') {
    finishReason = 'tool-calls';
  }

  const toolResults = await executeToolCalls(
    plan,
    toolCalls,
    messages,
    attempt,
    emitContent,
  );
  emit({ type: 'finish-step' });

  const usage = toUsage(rawUsage);
  const cost = costOf(usage, attempt.model.pricing);
  const responseMessages: ModelMessage[] = [
    buildAssistantMessage(text, toolCalls),
    ...(toolResults.length > 0 ? [buildToolResultMessage(toolResults)] : []),
  ];

  return {
    step: {
      index,
      model: attempt.model.info,
      text,
      toolCalls,
      toolResults,
      finishReason,
      usage,
      ...(cost !== undefined && { cost }),
    },
    responseMessages,
    durationMs: performance.now() - started,
    finish: { type: 'finish', finishReason },
  };
}
