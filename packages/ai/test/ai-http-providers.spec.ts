import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Injectable } from '@bunest/common';
import { Test } from '@bunest/testing';
import { AgentFunction, AiModule, AiService, type AiSchema } from '../src/index';

function summarySchema(): AiSchema<{ summary: string; score: number }, { summary: string; score: number }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        if (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as any).summary === 'string' &&
          typeof (value as any).score === 'number'
        ) {
          return { value: value as { summary: string; score: number } };
        }
        return { issues: [{ message: 'invalid summary object' }] };
      },
      jsonSchema: {
        input: () => ({
          type: 'object',
          properties: {
            summary: { type: 'string' },
            score: { type: 'number' },
          },
          required: ['summary', 'score'],
        }),
        output: () => ({
          type: 'object',
          properties: {
            summary: { type: 'string' },
            score: { type: 'number' },
          },
          required: ['summary', 'score'],
        }),
      },
    },
  };
}

describe('Real Bun-native HTTP/SSE Provider Clients (OpenAI, Anthropic, Google Gemini) via Bun.serve', () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl = '';
  let openai429Once = true;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = (await req.json().catch(() => ({}))) as any;

        // OpenAI Chat Completions (sync, tool-calling, structured output, SSE stream, 429 retry)
        if (url.pathname === '/openai/v1/chat/completions') {
          if (req.headers.get('x-trigger-429') === '1' && openai429Once) {
            openai429Once = false;
            return new Response(
              JSON.stringify({ error: { message: 'Rate limited' } }),
              {
                status: 429,
                headers: { 'content-type': 'application/json', 'retry-after': '0.005' },
              },
            );
          }

          if (body.stream) {
            const encoder = new TextEncoder();
            const chunks = [
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`,
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'OpenAI!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`,
              `data: [DONE]\n\n`,
            ];
            return new Response(
              new ReadableStream({
                start(controller) {
                  for (const c of chunks) controller.enqueue(encoder.encode(c));
                  controller.close();
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }

          if (body.response_format?.type === 'json_schema') {
            return Response.json({
              id: 'chatcmpl-obj',
              model: body.model,
              choices: [
                {
                  message: { role: 'assistant', content: JSON.stringify({ summary: 'Great', score: 9 }) },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 8 },
            });
          }

          const hasToolResult = (body.messages ?? []).some((m: any) => m.role === 'tool');
          if (Array.isArray(body.tools) && body.tools.length > 0 && !hasToolResult) {
            return Response.json({
              id: 'chatcmpl-tool',
              model: body.model,
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_oa_1',
                        type: 'function',
                        function: { name: 'add_nums', arguments: JSON.stringify({ a: 2, b: 3 }) },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            });
          }

          const toolMsg = (body.messages ?? []).find((m: any) => m.role === 'tool');
          return Response.json({
            id: 'chatcmpl-ok',
            model: body.model,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: toolMsg ? `Sum is ${toolMsg.content}` : 'OpenAI reply',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 14, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 4 } },
          });
        }

        // OpenAI Embeddings
        if (url.pathname === '/openai/v1/embeddings') {
          const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
          return Response.json({
            data: inputs.map((s, index) => ({ index, embedding: [s.length, index] })),
            usage: { prompt_tokens: inputs.length * 4 },
          });
        }

        // Anthropic Messages (sync + SSE)
        if (url.pathname === '/anthropic/v1/messages') {
          if (body.stream) {
            const encoder = new TextEncoder();
            const frames = [
              `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 3 } } })}\n\n`,
              `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude ' } })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streams!' } })}\n\n`,
              `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
              `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}\n\n`,
            ];
            return new Response(
              new ReadableStream({
                start(controller) {
                  for (const f of frames) controller.enqueue(encoder.encode(f));
                  controller.close();
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }

          return Response.json({
            id: 'msg_1',
            model: body.model,
            content: [{ type: 'text', text: `Anthropic ok (key=${req.headers.get('x-api-key')})` }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          });
        }

        // Google Gemini generateContent / streamGenerateContent / batchEmbedContents
        if (url.pathname.startsWith('/gemini/v1beta/models/')) {
          if (url.pathname.endsWith(':streamGenerateContent')) {
            const encoder = new TextEncoder();
            const frames = [
              `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini ' }] } }] })}\n\n`,
              `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'SSE!' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4 } })}\n\n`,
            ];
            return new Response(
              new ReadableStream({
                start(controller) {
                  for (const f of frames) controller.enqueue(encoder.encode(f));
                  controller.close();
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          if (url.pathname.endsWith(':batchEmbedContents')) {
            return Response.json({
              embeddings: (body.requests ?? []).map((_: any, i: number) => ({ values: [0.1 * (i + 1), 0.9] })),
            });
          }
          if (url.pathname.endsWith(':generateContent')) {
            const wantJson = body.generationConfig?.responseMimeType === 'application/json';
            return Response.json({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: wantJson
                          ? JSON.stringify({ summary: 'Gemini JSON', score: 10 })
                          : `Gemini ok (key=${url.searchParams.get('key')})`,
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 7 },
            });
          }
        }

        return new Response('Not found', { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it('executes OpenAI, Anthropic, and Google Gemini sync, structured, tool, streaming SSE, retry, and embedding calls over native fetch()', async () => {
    @Injectable()
    class MathTools {
      @AgentFunction({ name: 'add_nums', description: 'Adds two numbers' })
      add(input: { a: number; b: number }) {
        return input.a + input.b;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        AiModule.forRoot({
          models: {
            openai: {
              model: 'openai/gpt-4o',
              providerOptions: { openai: { baseURL: `${baseUrl}/openai/v1`, apiKey: 'sk-test' } },
              retry: { attempts: 3, backoff: { delay: 1, jitter: 'none' } },
            },
            anthropic: {
              model: 'anthropic/claude-sonnet-4-5',
              providerOptions: { anthropic: { baseURL: `${baseUrl}/anthropic/v1`, apiKey: 'ant-key' } },
            },
            gemini: {
              model: 'google/gemini-2.5-flash',
              providerOptions: { google: { baseURL: `${baseUrl}/gemini/v1beta`, apiKey: 'gem-key' } },
            },
          },
          embeddingModels: {
            openaiEmbed: {
              model: 'openai/text-embedding-3-small',
              providerOptions: { openai: { baseURL: `${baseUrl}/openai/v1`, apiKey: 'sk-test' } },
            },
            geminiEmbed: {
              model: 'google/text-embedding-004',
              providerOptions: { google: { baseURL: `${baseUrl}/gemini/v1beta`, apiKey: 'gem-key' } },
            },
          },
        }),
      ],
      providers: [MathTools],
    }).compile();
    await mod.init();
    const ai = mod.get(AiService);

    // 1. OpenAI tool loop + 429 retry-after recovery
    const oaTool = await ai.generateText({
      model: 'openai',
      prompt: 'Add 2 and 3',
      tools: ['add_nums'],
      headers: { 'x-trigger-429': '1' },
    });
    expect(oaTool.text).toBe('Sum is 5');
    expect(oaTool.steps.length).toBe(2);
    expect(oaTool.steps[0]?.attempts).toBe(2);
    expect(oaTool.usage.cachedInputTokens).toBe(4);

    // 2. OpenAI structured output
    const oaObj = await ai.generateObject({
      model: 'openai',
      prompt: 'score this',
      schema: summarySchema(),
    });
    expect(oaObj.object).toEqual({ summary: 'Great', score: 9 });

    // 3. OpenAI SSE stream
    const oaStream = ai.streamText({ model: 'openai', prompt: 'hi' });
    let oaText = '';
    for await (const d of oaStream.textStream) oaText += d;
    expect(oaText).toBe('Hello OpenAI!');
    expect((await oaStream.usage).totalTokens).toBe(10);

    // 4. OpenAI embeddings
    const oaEmbed = await ai.embedMany({
      model: 'openaiEmbed',
      values: ['abc', 'hello'],
    });
    expect(oaEmbed.embeddings).toEqual([[3, 0], [5, 1]]);
    expect(oaEmbed.usage.tokens).toBe(8);

    // 5. Anthropic sync + SSE
    const antRes = await ai.generateText({ model: 'anthropic', prompt: 'hi' });
    expect(antRes.text).toBe('Anthropic ok (key=ant-key)');
    expect(antRes.usage.cachedInputTokens).toBe(2);

    const antStream = ai.streamText({ model: 'anthropic', prompt: 'stream' });
    expect(await antStream.text).toBe('Claude streams!');

    // 6. Gemini sync + structured + SSE + embed
    const gemRes = await ai.generateText({ model: 'gemini', prompt: 'hi' });
    expect(gemRes.text).toBe('Gemini ok (key=gem-key)');

    const gemObj = await ai.generateObject({
      model: 'gemini',
      prompt: 'json',
      schema: summarySchema(),
    });
    expect(gemObj.object).toEqual({ summary: 'Gemini JSON', score: 10 });

    const gemStream = ai.streamText({ model: 'gemini', prompt: 'stream' });
    expect(await gemStream.text).toBe('Gemini SSE!');

    const gemEmbed = await ai.embed({ model: 'geminiEmbed', value: 'hello' });
    expect(gemEmbed.embedding).toEqual([0.1, 0.9]);
  });
});
