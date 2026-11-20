import type {
  EmbeddingModel,
  EmbeddingModelLike,
  LanguageModel,
  LanguageModelLike,
} from '../interfaces/ai-types.interface';

export interface ProviderApiCallError extends Error {
  statusCode: number;
  status: number;
  isRetryable: boolean;
  url: string;
  requestBodyValues: unknown;
  responseHeaders?: Record<string, string>;
}

/** Creates an APICallError-compatible error object matching AI SDK conventions. */
export function createProviderApiError(options: {
  message: string;
  url: string;
  requestBodyValues: unknown;
  statusCode: number;
  responseHeaders?: Record<string, string>;
}): ProviderApiCallError {
  const err = new Error(options.message) as ProviderApiCallError;
  err.name = 'APICallError';
  err.statusCode = options.statusCode;
  err.status = options.statusCode;
  err.isRetryable =
    options.statusCode === 408 ||
    options.statusCode === 409 ||
    options.statusCode === 429 ||
    options.statusCode >= 500;
  err.url = options.url;
  err.requestBodyValues = options.requestBodyValues;
  if (options.responseHeaders) {
    err.responseHeaders = options.responseHeaders;
  }
  return err;
}

function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf('/');
  if (slash > 0) {
    return {
      provider: spec.slice(0, slash).toLowerCase(),
      modelId: spec.slice(slash + 1),
    };
  }
  const colon = spec.indexOf(':');
  if (colon > 0) {
    return {
      provider: spec.slice(0, colon).toLowerCase(),
      modelId: spec.slice(colon + 1),
    };
  }
  if (spec.startsWith('claude')) {
    return { provider: 'anthropic', modelId: spec };
  }
  if (spec.startsWith('gemini') || spec.startsWith('text-embedding-004')) {
    return { provider: 'google', modelId: spec };
  }
  return { provider: 'openai', modelId: spec };
}

function headersRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function cleanHeaders(
  input?: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('');
  }
  return '';
}

async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        let eventName: string | undefined;
        const dataLines: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join('\n') };
        }
      }
    }
    const tail = buffer + decoder.decode();
    if (tail.trim()) {
      let eventName: string | undefined;
      const dataLines: string[] = [];
      for (const line of tail.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) {
        yield { event: eventName, data: dataLines.join('\n') };
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

async function assertOkResponse(
  res: Response,
  url: string,
  requestBodyValues: unknown,
): Promise<void> {
  if (res.ok) return;
  let message = `The provider answered ${res.status}`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as any;
        message =
          parsed?.error?.message ??
          parsed?.message ??
          (typeof parsed?.error === 'string' ? parsed.error : text);
      } catch {
        message = text;
      }
    }
  } catch {
    // ignore body read error
  }
  throw createProviderApiError({
    message,
    url,
    requestBodyValues,
    statusCode: res.status,
    responseHeaders: headersRecord(res.headers),
  });
}

function toOpenAiMessages(prompt: any[]): any[] {
  const out: any[] = [];
  for (const msg of prompt ?? []) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: extractTextContent(msg.content) });
    } else if (msg.role === 'user') {
      out.push({ role: 'user', content: extractTextContent(msg.content) });
    } else if (msg.role === 'assistant') {
      const parts = Array.isArray(msg.content) ? msg.content : [];
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : parts
              .filter((p: any) => p?.type === 'text')
              .map((p: any) => p.text)
              .join('');
      const toolCalls = (
        msg.toolCalls ??
        parts.filter((p: any) => p?.type === 'tool-call')
      ).map((tc: any) => ({
        id: tc.toolCallId ?? tc.id,
        type: 'function',
        function: {
          name: tc.toolName ?? tc.name,
          arguments:
            typeof tc.input === 'string'
              ? tc.input
              : JSON.stringify(tc.input ?? tc.args ?? {}),
        },
      }));
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      });
    } else if (msg.role === 'tool') {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === 'tool-result') {
            const val = part.output?.value ?? part.result ?? part.output;
            out.push({
              role: 'tool',
              tool_call_id: part.toolCallId,
              content: typeof val === 'string' ? val : JSON.stringify(val ?? null),
            });
          }
        }
      } else {
        out.push({
          role: 'tool',
          tool_call_id: msg.toolCallId ?? '',
          content:
            typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content ?? null),
        });
      }
    }
  }
  return out;
}

function mapOpenAiFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'stop';
  }
}

function createOpenAiLanguageModel(
  modelId: string,
  providerName = 'openai',
): LanguageModelLike {
  const resolveEndpoint = (options: any) => {
    const providerOpts =
      options.providerOptions?.[providerName] ?? options.providerOptions?.openai;
    const baseUrl = (
      providerOpts?.baseURL ??
      process.env['AI_GATEWAY_URL'] ??
      process.env['OPENAI_BASE_URL'] ??
      'https://api.openai.com/v1'
    ).replace(/\/$/, '');
    const apiKey =
      providerOpts?.apiKey ??
      process.env['AI_GATEWAY_API_KEY'] ??
      process.env['OPENAI_API_KEY'] ??
      '';
    return { url: `${baseUrl}/chat/completions`, apiKey };
  };

  const buildBody = (options: any, stream: boolean) => {
    const tools = options.tools ?? options.mode?.tools;
    const toolChoice = options.toolChoice ?? options.mode?.toolChoice;
    const body: Record<string, unknown> = {
      model: modelId,
      messages: toOpenAiMessages(options.prompt),
      ...(stream && { stream: true, stream_options: { include_usage: true } }),
      ...(options.maxOutputTokens !== undefined && {
        max_tokens: options.maxOutputTokens,
      }),
      ...(options.temperature !== undefined && {
        temperature: options.temperature,
      }),
      ...(options.topP !== undefined && { top_p: options.topP }),
      ...(options.seed !== undefined && { seed: options.seed }),
      ...(options.stopSequences !== undefined && {
        stop: options.stopSequences,
      }),
      ...(options.presencePenalty !== undefined && {
        presence_penalty: options.presencePenalty,
      }),
      ...(options.frequencyPenalty !== undefined && {
        frequency_penalty: options.frequencyPenalty,
      }),
    };

    if (options.responseFormat?.type === 'json' || options.mode?.type === 'object-json') {
      const schema = options.responseFormat?.schema ?? options.mode?.schema;
      const name = options.responseFormat?.name ?? options.mode?.name ?? 'response';
      body['response_format'] = schema
        ? {
            type: 'json_schema',
            json_schema: {
              name,
              ...(options.responseFormat?.description || options.mode?.description
                ? {
                    description:
                      options.responseFormat?.description ?? options.mode?.description,
                  }
                : {}),
              schema,
            },
          }
        : { type: 'json_object' };
    }

    if (Array.isArray(tools) && tools.length > 0) {
      body['tools'] = tools.map((t: any) => ({
        type: 'function',
        function: {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parameters: t.inputSchema ?? t.parameters ?? { type: 'object', properties: {} },
        },
      }));
      if (toolChoice) {
        if (typeof toolChoice === 'string') {
          body['tool_choice'] = toolChoice;
        } else if (toolChoice.type === 'tool') {
          body['tool_choice'] = {
            type: 'function',
            function: { name: toolChoice.toolName },
          };
        } else if (toolChoice.type) {
          body['tool_choice'] = toolChoice.type;
        }
      }
    }

    return body;
  };

  return {
    specificationVersion: 'v4',
    provider: providerName,
    modelId,
    async doGenerate(options: any) {
      const { url, apiKey } = resolveEndpoint(options);
      const body = buildBody(options, false);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...cleanHeaders(options.headers),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      await assertOkResponse(res, url, body);
      const data = (await res.json()) as any;
      const choice = data.choices?.[0];
      const msg = choice?.message ?? {};
      const content: any[] = [];
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function?.name ?? '',
          input: tc.function?.arguments ?? '{}',
        });
      }
      const unified = mapOpenAiFinishReason(choice?.finish_reason);
      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;
      const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      return {
        content,
        finishReason: { unified, raw: choice?.finish_reason ?? unified },
        usage: {
          inputTokens: { total: inputTokens, noCache: inputTokens - cached, cacheRead: cached },
          outputTokens: { total: outputTokens, text: outputTokens - reasoning, reasoning },
        },
        warnings: [],
        response: {
          id: data.id ?? 'openai-response',
          modelId: data.model ?? modelId,
          timestamp: new Date(),
          headers: headersRecord(res.headers),
        },
      };
    },

    async doStream(options: any) {
      const { url, apiKey } = resolveEndpoint(options);
      const body = buildBody(options, true);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...cleanHeaders(options.headers),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      await assertOkResponse(res, url, body);
      if (!res.body) {
        throw createProviderApiError({
          message: 'Empty response body from streaming endpoint',
          url,
          requestBodyValues: body,
          statusCode: 502,
        });
      }

      const rawBody = res.body;
      const stream = new ReadableStream<any>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          let textOpened = false;
          let finishReason = 'stop';
          let usage: any = {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          };
          const pendingCalls = new Map<
            number,
            { id: string; name: string; args: string }
          >();

          try {
            for await (const ev of parseSseEvents(rawBody, options.abortSignal)) {
              if (ev.data === '[DONE]') break;
              const chunk = JSON.parse(ev.data) as any;
              if (chunk.usage) {
                const inputTokens = chunk.usage.prompt_tokens ?? 0;
                const outputTokens = chunk.usage.completion_tokens ?? 0;
                const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
                const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
                usage = {
                  inputTokens: { total: inputTokens, noCache: inputTokens - cached, cacheRead: cached },
                  outputTokens: { total: outputTokens, text: outputTokens - reasoning, reasoning },
                };
              }
              const choice = chunk.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta ?? {};
              if (typeof delta.content === 'string' && delta.content.length > 0) {
                if (!textOpened) {
                  textOpened = true;
                  controller.enqueue({ type: 'text-start', id: 'text-0' });
                }
                controller.enqueue({
                  type: 'text-delta',
                  id: 'text-0',
                  delta: delta.content,
                });
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const entry = pendingCalls.get(idx) ?? {
                    id: tc.id ?? `call-${idx}`,
                    name: tc.function?.name ?? '',
                    args: '',
                  };
                  if (tc.id) entry.id = tc.id;
                  if (tc.function?.name) entry.name = tc.function.name;
                  if (tc.function?.arguments) entry.args += tc.function.arguments;
                  pendingCalls.set(idx, entry);
                }
              }
              if (choice.finish_reason) {
                finishReason = mapOpenAiFinishReason(choice.finish_reason);
              }
            }
            if (textOpened) {
              controller.enqueue({ type: 'text-end', id: 'text-0' });
            }
            for (const tc of pendingCalls.values()) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.args || '{}',
              });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: finishReason, raw: finishReason },
              usage,
            });
            controller.close();
          } catch (error) {
            controller.enqueue({ type: 'error', error });
            controller.close();
          }
        },
      });

      return { stream };
    },
  };
}

function createAnthropicLanguageModel(modelId: string): LanguageModelLike {
  const resolveEndpoint = (options: any) => {
    const providerOpts = options.providerOptions?.anthropic;
    const baseUrl = (
      providerOpts?.baseURL ??
      process.env['ANTHROPIC_BASE_URL'] ??
      'https://api.anthropic.com/v1'
    ).replace(/\/$/, '');
    const apiKey =
      providerOpts?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
    return { url: `${baseUrl}/messages`, apiKey };
  };

  const buildBody = (options: any, stream: boolean) => {
    const systemParts: string[] = [];
    const messages: any[] = [];
    for (const msg of options.prompt ?? []) {
      if (msg.role === 'system') {
        systemParts.push(extractTextContent(msg.content));
      } else if (msg.role === 'user') {
        messages.push({ role: 'user', content: extractTextContent(msg.content) });
      } else if (msg.role === 'assistant') {
        const blocks: any[] = [];
        const text = extractTextContent(msg.content);
        if (text) blocks.push({ type: 'text', text });
        const parts = Array.isArray(msg.content) ? msg.content : [];
        for (const tc of msg.toolCalls ?? parts.filter((p: any) => p?.type === 'tool-call')) {
          const parsedInput =
            typeof tc.input === 'string'
              ? JSON.parse(tc.input || '{}')
              : (tc.input ?? {});
          blocks.push({
            type: 'tool_use',
            id: tc.toolCallId ?? tc.id,
            name: tc.toolName ?? tc.name,
            input: parsedInput,
          });
        }
        messages.push({ role: 'assistant', content: blocks });
      } else if (msg.role === 'tool') {
        const blocks: any[] = [];
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === 'tool-result') {
              const val = part.output?.value ?? part.result ?? part.output;
              blocks.push({
                type: 'tool_result',
                tool_use_id: part.toolCallId,
                content: typeof val === 'string' ? val : JSON.stringify(val ?? null),
                ...(part.output?.type === 'error-text' && { is_error: true }),
              });
            }
          }
        }
        messages.push({ role: 'user', content: blocks });
      }
    }

    const tools = options.tools ?? options.mode?.tools;
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: options.maxOutputTokens ?? 4096,
      messages,
      ...(systemParts.length > 0 && { system: systemParts.join('\n') }),
      ...(stream && { stream: true }),
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.topP !== undefined && { top_p: options.topP }),
      ...(options.topK !== undefined && { top_k: options.topK }),
      ...(options.stopSequences !== undefined && { stop_sequences: options.stopSequences }),
    };

    if (Array.isArray(tools) && tools.length > 0) {
      body['tools'] = tools.map((t: any) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        input_schema: t.inputSchema ?? t.parameters ?? { type: 'object', properties: {} },
      }));
    }

    return body;
  };

  const mapStopReason = (reason: string | null | undefined): string => {
    switch (reason) {
      case 'tool_use':
        return 'tool-calls';
      case 'max_tokens':
        return 'length';
      default:
        return 'stop';
    }
  };

  return {
    specificationVersion: 'v4',
    provider: 'anthropic',
    modelId,
    async doGenerate(options: any) {
      const { url, apiKey } = resolveEndpoint(options);
      const body = buildBody(options, false);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...cleanHeaders(options.headers),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      await assertOkResponse(res, url, body);
      const data = (await res.json()) as any;
      const content: any[] = [];
      for (const block of data.content ?? []) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text ?? '' });
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            input: JSON.stringify(block.input ?? {}),
          });
        }
      }
      const unified = mapStopReason(data.stop_reason);
      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;
      const cached = data.usage?.cache_read_input_tokens ?? 0;
      return {
        content,
        finishReason: { unified, raw: data.stop_reason ?? unified },
        usage: {
          inputTokens: { total: inputTokens, noCache: inputTokens - cached, cacheRead: cached },
          outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
        },
        warnings: [],
        response: {
          id: data.id ?? 'anthropic-response',
          modelId: data.model ?? modelId,
          timestamp: new Date(),
          headers: headersRecord(res.headers),
        },
      };
    },

    async doStream(options: any) {
      const { url, apiKey } = resolveEndpoint(options);
      const body = buildBody(options, true);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...cleanHeaders(options.headers),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      await assertOkResponse(res, url, body);
      if (!res.body) {
        throw createProviderApiError({
          message: 'Empty response body from Anthropic streaming endpoint',
          url,
          requestBodyValues: body,
          statusCode: 502,
        });
      }

      const rawBody = res.body;
      const stream = new ReadableStream<any>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          let inputTokens = 0;
          let outputTokens = 0;
          let cached = 0;
          let finishReason = 'stop';
          const blocks = new Map<number, { type: string; id?: string; name?: string; json?: string }>();

          try {
            for await (const ev of parseSseEvents(rawBody, options.abortSignal)) {
              if (!ev.data || ev.data === '[DONE]') continue;
              const payload = JSON.parse(ev.data) as any;
              const type = ev.event ?? payload.type;
              if (type === 'message_start') {
                inputTokens = payload.message?.usage?.input_tokens ?? 0;
                cached = payload.message?.usage?.cache_read_input_tokens ?? 0;
              } else if (type === 'content_block_start') {
                const idx = payload.index ?? 0;
                const block = payload.content_block ?? {};
                if (block.type === 'text') {
                  blocks.set(idx, { type: 'text' });
                  controller.enqueue({ type: 'text-start', id: `text-${idx}` });
                } else if (block.type === 'tool_use') {
                  blocks.set(idx, { type: 'tool_use', id: block.id, name: block.name, json: '' });
                }
              } else if (type === 'content_block_delta') {
                const idx = payload.index ?? 0;
                const delta = payload.delta ?? {};
                if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                  controller.enqueue({ type: 'text-delta', id: `text-${idx}`, delta: delta.text });
                } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                  const b = blocks.get(idx);
                  if (b) b.json = (b.json ?? '') + delta.partial_json;
                }
              } else if (type === 'content_block_stop') {
                const idx = payload.index ?? 0;
                const b = blocks.get(idx);
                if (b?.type === 'text') {
                  controller.enqueue({ type: 'text-end', id: `text-${idx}` });
                } else if (b?.type === 'tool_use') {
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: b.id ?? `call-${idx}`,
                    toolName: b.name ?? '',
                    input: b.json || '{}',
                  });
                }
              } else if (type === 'message_delta') {
                if (payload.delta?.stop_reason) {
                  finishReason = mapStopReason(payload.delta.stop_reason);
                }
                if (payload.usage?.output_tokens !== undefined) {
                  outputTokens = payload.usage.output_tokens;
                }
              }
            }
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: finishReason, raw: finishReason },
              usage: {
                inputTokens: { total: inputTokens, noCache: inputTokens - cached, cacheRead: cached },
                outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
              },
            });
            controller.close();
          } catch (error) {
            controller.enqueue({ type: 'error', error });
            controller.close();
          }
        },
      });

      return { stream };
    },
  };
}

function createGoogleLanguageModel(modelId: string): LanguageModelLike {
  const resolveEndpoint = (options: any, action: string, sse = false) => {
    const providerOpts = options.providerOptions?.google ?? options.providerOptions?.gemini;
    const baseUrl = (
      providerOpts?.baseURL ??
      process.env['GEMINI_BASE_URL'] ??
      'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/$/, '');
    const apiKey =
      providerOpts?.apiKey ??
      process.env['GEMINI_API_KEY'] ??
      process.env['GOOGLE_GENERATIVE_AI_API_KEY'] ??
      '';
    const query = new URLSearchParams();
    if (sse) query.set('alt', 'sse');
    if (apiKey) query.set('key', apiKey);
    const qs = query.toString();
    return `${baseUrl}/models/${encodeURIComponent(modelId)}:${action}${qs ? `?${qs}` : ''}`;
  };

  const buildBody = (options: any) => {
    const systemParts: string[] = [];
    const contents: any[] = [];
    for (const msg of options.prompt ?? []) {
      if (msg.role === 'system') {
        systemParts.push(extractTextContent(msg.content));
      } else if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: extractTextContent(msg.content) }],
        });
      } else if (msg.role === 'assistant') {
        const parts: any[] = [];
        const text = extractTextContent(msg.content);
        if (text) parts.push({ text });
        const rawParts = Array.isArray(msg.content) ? msg.content : [];
        for (const tc of msg.toolCalls ?? rawParts.filter((p: any) => p?.type === 'tool-call')) {
          parts.push({
            functionCall: {
              name: tc.toolName ?? tc.name,
              args: typeof tc.input === 'string' ? JSON.parse(tc.input || '{}') : (tc.input ?? {}),
            },
          });
        }
        contents.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        const parts: any[] = [];
        if (Array.isArray(msg.content)) {
          for (const p of msg.content) {
            if (p?.type === 'tool-result') {
              const val = p.output?.value ?? p.result ?? p.output;
              parts.push({
                functionResponse: {
                  name: p.toolName,
                  response: typeof val === 'object' && val !== null ? val : { result: val },
                },
              });
            }
          }
        }
        contents.push({ role: 'user', parts });
      }
    }

    const generationConfig: Record<string, unknown> = {
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.maxOutputTokens !== undefined && { maxOutputTokens: options.maxOutputTokens }),
      ...(options.topP !== undefined && { topP: options.topP }),
      ...(options.topK !== undefined && { topK: options.topK }),
      ...(options.stopSequences !== undefined && { stopSequences: options.stopSequences }),
    };

    if (options.responseFormat?.type === 'json' || options.mode?.type === 'object-json') {
      generationConfig['responseMimeType'] = 'application/json';
      const schema = options.responseFormat?.schema ?? options.mode?.schema;
      if (schema) generationConfig['responseSchema'] = schema;
    }

    const tools = options.tools ?? options.mode?.tools;
    return {
      contents,
      ...(systemParts.length > 0 && {
        systemInstruction: { parts: [{ text: systemParts.join('\n') }] },
      }),
      ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
      ...(Array.isArray(tools) && tools.length > 0 && {
        tools: [
          {
            functionDeclarations: tools.map((t: any) => ({
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              parameters: t.inputSchema ?? t.parameters ?? { type: 'object', properties: {} },
            })),
          },
        ],
      }),
    };
  };

  return {
    specificationVersion: 'v4',
    provider: 'google',
    modelId,
    async doGenerate(options: any) {
      const url = resolveEndpoint(options, 'generateContent');
      const body = buildBody(options);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...cleanHeaders(options.headers),
        },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      await assertOkResponse(res, url, body);
      const data = (await res.json()) as any;
      const candidate = data.candidates?.[0];
      const content: any[] = [];
      let callSeq = 0;
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text === 'string') {
          content.push({ type: 'text', text: part.text });
        } else if (part.functionCall) {
          content.push({
            type: 'tool-call',
            toolCallId: `gemini-call-${++callSeq}`,
            toolName: part.functionCall.name,
            input: JSON.stringify(part.functionCall.args ?? {}),
          });
        }
      }
      const hasCalls = content.some((p) => p.type === 'tool-call');
      const unified = hasCalls
        ? 'tool-calls'
        : candidate?.finishReason === 'MAX_TOKENS'
          ? 'length'
          : 'stop';
      const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
      const cached = data.usageMetadata?.cachedContentTokenCount ?? 0;
      return {
        content,
        finishReason: { unified, raw: candidate?.finishReason ?? unified },
        usage: {
          inputTokens: { total: inputTokens, noCache: inputTokens - cached, cacheRead: cached },
          outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
        },
        warnings: [],
        response: {
          id: 'gemini-response',
          modelId,
          timestamp: new Date(),
          headers: headersRecord(res.headers),
        },
      };
    },

    async doStream(options: any) {
      const url = resolveEndpoint(options, 'streamGenerateContent', true);
      const body = buildBody(options);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...cleanHeaders(options.headers),
        },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      await assertOkResponse(res, url, body);
      if (!res.body) {
        throw createProviderApiError({
          message: 'Empty response body from Gemini streaming endpoint',
          url,
          requestBodyValues: body,
          statusCode: 502,
        });
      }
      const rawBody = res.body;
      const stream = new ReadableStream<any>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          let textOpened = false;
          let callSeq = 0;
          let finishReason = 'stop';
          let usage: any = {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          };
          try {
            for await (const ev of parseSseEvents(rawBody, options.abortSignal)) {
              if (!ev.data || ev.data === '[DONE]') continue;
              const data = JSON.parse(ev.data) as any;
              const candidate = data.candidates?.[0];
              for (const part of candidate?.content?.parts ?? []) {
                if (typeof part.text === 'string' && part.text.length > 0) {
                  if (!textOpened) {
                    textOpened = true;
                    controller.enqueue({ type: 'text-start', id: 'text-0' });
                  }
                  controller.enqueue({ type: 'text-delta', id: 'text-0', delta: part.text });
                } else if (part.functionCall) {
                  finishReason = 'tool-calls';
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: `gemini-call-${++callSeq}`,
                    toolName: part.functionCall.name,
                    input: JSON.stringify(part.functionCall.args ?? {}),
                  });
                }
              }
              if (data.usageMetadata) {
                const inputTokens = data.usageMetadata.promptTokenCount ?? 0;
                const outputTokens = data.usageMetadata.candidatesTokenCount ?? 0;
                const cached = data.usageMetadata.cachedContentTokenCount ?? 0;
                usage = {
                  inputTokens: { total: inputTokens, noCache: inputTokens - cached, cacheRead: cached },
                  outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
                };
              }
            }
            if (textOpened) controller.enqueue({ type: 'text-end', id: 'text-0' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: finishReason, raw: finishReason },
              usage,
            });
            controller.close();
          } catch (error) {
            controller.enqueue({ type: 'error', error });
            controller.close();
          }
        },
      });
      return { stream };
    },
  };
}

function createOpenAiEmbeddingModel(
  modelId: string,
  providerName = 'openai',
): EmbeddingModelLike {
  return {
    specificationVersion: 'v4',
    provider: providerName,
    modelId,
    maxEmbeddingsPerCall: 2048,
    supportsParallelCalls: true,
    async doEmbed(options: any) {
      const providerOpts =
        options.providerOptions?.[providerName] ?? options.providerOptions?.openai;
      const baseUrl = (
        providerOpts?.baseURL ??
        process.env['AI_GATEWAY_URL'] ??
        process.env['OPENAI_BASE_URL'] ??
        'https://api.openai.com/v1'
      ).replace(/\/$/, '');
      const apiKey =
        providerOpts?.apiKey ??
        process.env['AI_GATEWAY_API_KEY'] ??
        process.env['OPENAI_API_KEY'] ??
        '';
      const url = `${baseUrl}/embeddings`;
      const body = { model: modelId, input: options.values };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...cleanHeaders(options.headers),
        },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      await assertOkResponse(res, url, body);
      const data = (await res.json()) as any;
      const sorted = [...(data.data ?? [])].sort(
        (a: any, b: any) => (a.index ?? 0) - (b.index ?? 0),
      );
      return {
        embeddings: sorted.map((d: any) => d.embedding),
        usage: { tokens: data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? 0 },
        warnings: [],
        response: { headers: headersRecord(res.headers), body: data },
      };
    },
  };
}

function createGoogleEmbeddingModel(modelId: string): EmbeddingModelLike {
  return {
    specificationVersion: 'v4',
    provider: 'google',
    modelId,
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
    async doEmbed(options: any) {
      const providerOpts = options.providerOptions?.google ?? options.providerOptions?.gemini;
      const baseUrl = (
        providerOpts?.baseURL ??
        process.env['GEMINI_BASE_URL'] ??
        'https://generativelanguage.googleapis.com/v1beta'
      ).replace(/\/$/, '');
      const apiKey =
        providerOpts?.apiKey ??
        process.env['GEMINI_API_KEY'] ??
        process.env['GOOGLE_GENERATIVE_AI_API_KEY'] ??
        '';
      const url = `${baseUrl}/models/${encodeURIComponent(modelId)}:batchEmbedContents${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
      const body = {
        requests: (options.values as string[]).map((text) => ({
          model: `models/${modelId}`,
          content: { parts: [{ text }] },
        })),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...cleanHeaders(options.headers),
        },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      await assertOkResponse(res, url, body);
      const data = (await res.json()) as any;
      const embeddings = (data.embeddings ?? []).map((e: any) => e.values ?? []);
      return {
        embeddings,
        usage: { tokens: (options.values as string[]).reduce((acc, s) => acc + Math.ceil(s.length / 4), 0) },
        warnings: [],
        response: { headers: headersRecord(res.headers), body: data },
      };
    },
  };
}

/**
 * Resolves a `LanguageModel` (object or string gateway/provider id) to an executable `LanguageModelLike`
 * backed by Bun's native `fetch()` for OpenAI, Anthropic, and Google Gemini protocols.
 */
export function resolveLanguageModel(model: LanguageModel): LanguageModelLike {
  if (typeof model !== 'string') {
    return model;
  }
  const defaultProvider = (globalThis as any).AI_SDK_DEFAULT_PROVIDER;
  if (typeof defaultProvider?.languageModel === 'function') {
    return defaultProvider.languageModel(model);
  }
  const { provider, modelId } = parseModelSpec(model);
  if (provider === 'anthropic') {
    return createAnthropicLanguageModel(modelId);
  }
  if (provider === 'google' || provider === 'gemini') {
    return createGoogleLanguageModel(modelId);
  }
  return createOpenAiLanguageModel(modelId, provider);
}

/**
 * Resolves an `EmbeddingModel` (object or string gateway/provider id) to an executable `EmbeddingModelLike`
 * backed by Bun's native `fetch()`.
 */
export function resolveEmbeddingModel(model: EmbeddingModel): EmbeddingModelLike {
  if (typeof model !== 'string') {
    return model;
  }
  const defaultProvider = (globalThis as any).AI_SDK_DEFAULT_PROVIDER;
  if (typeof defaultProvider?.embeddingModel === 'function') {
    return defaultProvider.embeddingModel(model);
  }
  const { provider, modelId } = parseModelSpec(model);
  if (provider === 'google' || provider === 'gemini') {
    return createGoogleEmbeddingModel(modelId);
  }
  return createOpenAiEmbeddingModel(modelId, provider);
}
