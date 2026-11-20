import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'bun:test';
import {
  BadRequestException,
  Injectable,
  UseGuards,
  UseInterceptors,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
} from '@bunest/common';
import { Test } from '@bunest/testing';
import {
  AgentFunction,
  AiExecutionContext,
  AiModule,
  AiService,
  AiToolError,
  AiTools,
  type AgentFunctionContext,
  type AiContextType,
  type AiSchema,
} from '../src/index';
import { FakeModel, callTool, fakeModel } from '../src/testing/index';

function orderInputSchema(): AiSchema<{ orderId: string }, { orderId: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        if (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as any).orderId === 'string' &&
          (value as any).orderId.startsWith('ord_')
        ) {
          return { value: { orderId: (value as any).orderId } };
        }
        return {
          issues: [{ message: 'must start with ord_', path: ['orderId'] }],
        };
      },
      jsonSchema: {
        input: () => ({
          type: 'object',
          properties: { orderId: { type: 'string' } },
          required: ['orderId'],
        }),
        output: () => ({
          type: 'object',
          properties: { orderId: { type: 'string' } },
          required: ['orderId'],
        }),
      },
    },
  };
}

class SupportRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType<AiContextType>() !== 'ai') {
      return true;
    }
    const aiCtx = AiExecutionContext.create(context);
    expect(aiCtx.getName()).toBe('find_order');
    expect(aiCtx.switchToRpc().getData()).toEqual(aiCtx.getInput());
    expect(aiCtx.getArgByIndex(0)).toEqual(aiCtx.getInput());
    expect(aiCtx.switchToHttp().getRequest()).toEqual(aiCtx.getInput());
    expect(aiCtx.switchToWs().getClient()).toEqual(aiCtx.getInput());
    return aiCtx.getRequest()?.user?.role === 'support';
  }
}

class TagResultInterceptor implements BunestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    const res = await next.handle();
    if (typeof res === 'object' && res !== null) {
      return { ...(res as Record<string, unknown>), intercepted: true };
    }
    return res;
  }
}

function createMockNodeResponse() {
  const res: any = new EventEmitter();
  const headers: Record<string, string | string[]> = {};
  const chunks: Buffer[] = [];
  res.headersSent = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.status = 0;
  res.headers = headers;
  res.setHeader = (name: string, value: string | string[]) => {
    headers[name.toLowerCase()] = value;
  };
  res.hasHeader = (name: string) => name.toLowerCase() in headers;
  res.writeHead = (status: number, hdrs?: Record<string, string>) => {
    res.status = status;
    res.headersSent = true;
    if (hdrs) {
      for (const [k, v] of Object.entries(hdrs)) {
        headers[k.toLowerCase()] = v;
      }
    }
  };
  res.flushHeaders = () => {
    res.headersSent = true;
  };
  res.write = (chunk: Uint8Array | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  res.end = () => {
    res.writableFinished = true;
    res.emit('finish');
  };
  res.destroy = () => {
    res.destroyed = true;
    res.emit('close');
  };
  res.getBodyText = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

describe('Agent Functions, Enhancers, Multi-step Tool Loop & AiTextStream', () => {
  @Injectable()
  class OrdersTools {
    @AgentFunction({
      name: 'find_order',
      description: 'Looks up an order by id',
      inputSchema: orderInputSchema(),
      scopes: ['orders:read'],
    })
    @UseGuards(SupportRoleGuard)
    @UseInterceptors(TagResultInterceptor)
    async findOrder(
      input: { orderId: string },
      ctx: AgentFunctionContext<{ user?: { role?: string } }>,
    ) {
      await ctx.reportProgress(1, 2, 'querying');
      return {
        orderId: input.orderId,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        status: 'shipped',
      };
    }

    @AgentFunction({ name: 'bad_req' })
    failWithHttp() {
      throw new BadRequestException('Order already refunded');
    }

    @AgentFunction({ name: 'secret_crash' })
    failWithSecret() {
      throw new Error('DB_PASSWORD=supersecret');
    }

    @AgentFunction({ name: 'mcp_tool' })
    mcpResult() {
      return {
        content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }],
        structuredContent: { ok: true },
      };
    }
  }

  it('discovers @AgentFunction tools, enforces scopes/schema/enhancers, and runs multi-step loop', async () => {
    const model = new FakeModel([
      {
        toolCalls: [{ name: 'find_order', input: { orderId: 'ord_42' }, id: 'tc_1' }],
        usage: { inputTokens: 15, outputTokens: 5 },
      },
      {
        text: 'Order ord_42 has shipped.',
        usage: { inputTokens: 25, outputTokens: 10 },
      },
    ]);

    const mod = await Test.createTestingModule({
      imports: [AiModule.forRoot({ models: { default: model } })],
      providers: [OrdersTools],
    }).compile();
    await mod.init();

    const ai = mod.get(AiService);
    const tools = mod.get(AiTools);
    expect(tools.tools.has('find_order')).toBe(true);
    expect(tools.resolve([OrdersTools]).map((t) => t.name)).toContain('find_order');

    const res = await ai.generateText({
      instructions: 'Be concise',
      prompt: 'Where is ord_42?',
      tools: [OrdersTools],
      caller: {
        scopes: ['orders:read'],
        request: { user: { role: 'support' } },
      },
    });

    expect(res.text).toBe('Order ord_42 has shipped.');
    expect(res.steps.length).toBe(2);
    expect(res.toolCalls.length).toBe(1);
    expect(res.toolResults[0]?.output).toEqual({
      orderId: 'ord_42',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'shipped',
      intercepted: true,
    });
    expect(res.usage.inputTokens).toBe(40);
    expect(res.usage.outputTokens).toBe(15);
    expect(model.calls[0]?.instructions).toBe('Be concise');
    expect(model.calls[0]?.lastUserMessage).toBe('Where is ord_42?');
    expect(model.calls[1]?.toolResults[0]?.toolCallId).toBe('tc_1');

    // Direct callTool helper tests:
    // 1. Missing scope -> AiToolError
    await expect(
      callTool(mod, 'find_order', { orderId: 'ord_1' }, { caller: { scopes: [] } }),
    ).rejects.toBeInstanceOf(AiToolError);

    // 2. Guard denies non-support role
    await expect(
      callTool(
        mod,
        'find_order',
        { orderId: 'ord_1' },
        { caller: { scopes: ['orders:read'], request: { user: { role: 'guest' } } } },
      ),
    ).rejects.toThrow('Forbidden resource');

    // 3. Invalid schema input
    await expect(
      callTool(mod, 'find_order', { orderId: 'bad_id' }, { caller: { scopes: ['orders:read'] } }),
    ).rejects.toThrow('Invalid input');

    // 4. HttpException message exposed, generic Error scrubbed
    await expect(callTool(mod, 'bad_req')).rejects.toThrow('Order already refunded');
    await expect(callTool(mod, 'secret_crash')).rejects.toThrow('Internal server error');

    // 5. MCP CallToolResult structuredContent extraction
    expect(await callTool(mod, 'mcp_tool')).toEqual({ ok: true });
  });

  it('streams text, tool progress, UI message stream SSE response, and pipes to Node responses', async () => {
    const model = fakeModel(
      { toolCalls: [{ name: 'find_order', input: { orderId: 'ord_99' }, id: 'tc_stream' }] },
      { text: 'Hello streaming world!', chunkDelay: 2 },
    );

    const mod = await Test.createTestingModule({
      imports: [AiModule.forRoot({ models: { default: model } })],
      providers: [OrdersTools],
    }).compile();
    await mod.init();

    const ai = mod.get(AiService);
    const stream = ai.streamText({
      prompt: 'stream ord_99',
      tools: ['find_order'],
      caller: {
        scopes: ['orders:read'],
        request: { user: { role: 'support' } },
      },
    });

    // Reader 1: textStream
    const pieces: string[] = [];
    for await (const chunk of stream.textStream) {
      pieces.push(chunk);
    }
    expect(pieces.join('')).toBe('Hello streaming world!');
    expect(await stream.text).toBe('Hello streaming world!');
    expect(await stream.finishReason).toBe('stop');
    expect((await stream.steps).length).toBe(2);

    // Reader 2: independent replay via toUIMessageStreamResponse
    const webRes = stream.toUIMessageStreamResponse({ keepAlive: false });
    expect(webRes.headers.get('content-type')).toBe('text/event-stream');
    expect(webRes.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const sseText = await webRes.text();
    expect(sseText).toContain('"type":"data-tool-progress"');
    expect(sseText).toContain('"type":"text-delta"');
    expect(sseText).toContain('data: [DONE]');

    // Pipe to Node response (UI stream & plain text)
    const stream2 = ai.streamText({
      model: fakeModel('Piped answer'),
      prompt: 'pipe',
    });
    const nodeRes = createMockNodeResponse();
    await stream2.pipeUIMessageStreamToResponse(nodeRes, { keepAlive: false });
    expect(nodeRes.status).toBe(200);
    expect(nodeRes.getBodyText()).toContain('Piped');

    const stream3 = ai.streamText({
      model: fakeModel('Plain text stream'),
      prompt: 'plain',
    });
    const textRes = createMockNodeResponse();
    await stream3.pipeTextStreamToResponse(textRes);
    expect(textRes.status).toBe(200);
    expect(textRes.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(textRes.getBodyText()).toBe('Plain text stream');

    // Fastify reply hijack & header copy
    const fastifyRaw = createMockNodeResponse();
    let hijacked = false;
    const fastifyReply = {
      raw: fastifyRaw,
      hijack: () => {
        hijacked = true;
      },
      getHeaders: () => ({ 'x-cors': 'allowed' }),
    };
    const stream4 = ai.streamText({ model: fakeModel('Fastify ok'), prompt: 'hi' });
    await stream4.pipeUIMessageStreamToResponse(fastifyReply, { keepAlive: false });
    expect(hijacked).toBe(true);
    expect(fastifyRaw.headers['x-cors']).toBe('allowed');
    expect(fastifyRaw.getBodyText()).toContain('Fastify');

    // Pre-first-chunk error rejects pipeUIMessageStreamToResponse without sending headers
    const failRes = createMockNodeResponse();
    const failStream = ai.streamText({
      model: fakeModel(new Error('upstream down')),
      prompt: 'fail',
      retry: false,
    });
    await expect(
      failStream.pipeUIMessageStreamToResponse(failRes, { keepAlive: false }),
    ).rejects.toThrow();
    expect(failRes.headersSent).toBe(false);

    // toUIMessageStream custom errorText on mid-stream error
    const midErrStream = ai.streamText({
      model: fakeModel({ text: 'part', streamError: new Error('cut off') }),
      prompt: 'mid-err',
      retry: false,
    });
    const uiReader = midErrStream
      .toUIMessageStream({ errorText: () => 'custom friendly error' })
      .getReader();
    const uiChunks: any[] = [];
    for (;;) {
      const { done, value } = await uiReader.read();
      if (done) break;
      uiChunks.push(value);
    }
    expect(uiChunks.some((c) => c.type === 'error' && c.errorText === 'custom friendly error')).toBe(true);

    // Keep-alive comment test
    const slowStream = ai.streamText({
      model: fakeModel({ text: 'slow', delay: 45 }),
      prompt: 'slow',
    });
    const kaRes = slowStream.toUIMessageStreamResponse({ keepAlive: '15ms' });
    const kaBody = await kaRes.text();
    expect(kaBody).toContain(': keep-alive');
    expect(kaBody).toContain('slow');
  });
});
