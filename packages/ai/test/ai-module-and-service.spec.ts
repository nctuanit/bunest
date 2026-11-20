import 'reflect-metadata';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { describe, expect, it } from 'bun:test';
import { Injectable, Module } from '@bunest/common';
import { ResilienceModule } from '@bunest/resilience';
import { Test } from '@bunest/testing';
import {
  AI_MODULE_OPTIONS,
  AiBudgetExceededError,
  AiConfigurationError,
  AiEmbeddingModels,
  AiError,
  AiModelError,
  AiModels,
  AiModule,
  AiOutputError,
  AiService,
  DEFAULT_MODEL_NAME,
  InjectEmbeddingModel,
  InjectModel,
  describeModel,
  getEmbeddingModelToken,
  getModelToken,
  type AiEmbeddingUsageEvent,
  type AiOptionsFactory,
  type AiSchema,
  type AiUsageEvent,
} from '../src/index';
import {
  FakeEmbeddingModel,
  FakeModel,
  fakeEmbeddingModel,
  fakeModel,
  overrideEmbeddingModels,
  overrideModels,
  providerError,
} from '../src/testing/index';

function makeObjectSchema<T extends Record<string, unknown>>(
  jsonSchema: Record<string, unknown>,
  check: (value: unknown) => { value: T } | { issues: Array<{ message: string; path?: PropertyKey[] }> },
): AiSchema<T, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => check(value),
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

describe('AiModule, Models, AiService, Resilience & Embeddings', () => {
  it('registers models and embedding models, supports @InjectModel and @InjectEmbeddingModel', async () => {
    const defaultModel = fakeModel('hello');
    const fastModel = fakeModel('quick');
    const embedModel = fakeEmbeddingModel({ embeddings: [[0.1, 0.2]] });

    @Injectable()
    class Consumer {
      constructor(
        @InjectModel() readonly primary: unknown,
        @InjectModel('fast') readonly fast: unknown,
        @InjectEmbeddingModel() readonly embedder: unknown,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        AiModule.forRoot({
          isGlobal: true,
          models: { default: defaultModel, fast: fastModel },
          embeddingModels: { default: embedModel },
        }),
      ],
      providers: [Consumer],
    }).compile();

    const consumer = mod.get(Consumer);
    expect(consumer.primary).toBe(defaultModel);
    expect(consumer.fast).toBe(fastModel);
    expect(consumer.embedder).toBe(embedModel);

    const models = mod.get(AiModels);
    expect(models.names()).toEqual(['default', 'fast']);
    expect(models.has('fast')).toBe(true);
    expect(models.has('missing')).toBe(false);
    expect(models.get()).toBe(defaultModel);
    expect(models.get('fast')).toBe(fastModel);

    const embeddingModels = mod.get(AiEmbeddingModels);
    expect(embeddingModels.names()).toEqual(['default']);
    expect(embeddingModels.has('default')).toBe(true);
    expect(embeddingModels.get()).toBe(embedModel);

    expect(getModelToken()).toBe(`AI_MODEL_${DEFAULT_MODEL_NAME}`);
    expect(getEmbeddingModelToken('small')).toBe('AI_EMBEDDING_MODEL_small');
    expect(mod.get(AI_MODULE_OPTIONS)).toBeDefined();
    expect(describeModel({ name: 'fast', provider: 'fake', modelId: 'm1' })).toBe('fast');
    expect(describeModel({ provider: 'fake', modelId: 'm1' })).toBe('fake:m1');
  });

  it('supports AiModule.forRootAsync with useFactory and useClass', async () => {
    const model = fakeModel('async-reply');

    const modFactory = await Test.createTestingModule({
      imports: [
        AiModule.forRootAsync({
          modelNames: ['default'],
          useFactory: async () => ({
            models: { default: model },
          }),
        }),
      ],
    }).compile();

    const ai = modFactory.get(AiService);
    const res = await ai.generateText({ prompt: 'hi' });
    expect(res.text).toBe('async-reply');

    @Injectable()
    class ConfigFactory implements AiOptionsFactory {
      createAiOptions() {
        return { models: { default: fakeModel('from-class') } };
      }
    }

    const modClass = await Test.createTestingModule({
      imports: [
        AiModule.forRootAsync({
          useClass: ConfigFactory,
        }),
      ],
    }).compile();

    const res2 = await modClass.get(AiService).generateText({ prompt: 'hello' });
    expect(res2.text).toBe('from-class');
  });

  it('supports overrideModels and overrideEmbeddingModels while preserving pricing & settings', async () => {
    const original = fakeModel('orig');
    const replacement = fakeModel({
      text: 'replaced',
      usage: { inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 200_000 },
    });
    const origEmbed = fakeEmbeddingModel({ embeddings: [[1]] });
    const replEmbed = fakeEmbeddingModel({
      embeddings: [[0.5, 0.6]],
      usage: { tokens: 1_000_000 },
    });

    const builder = Test.createTestingModule({
      imports: [
        AiModule.forRoot({
          models: {
            default: {
              model: original,
              pricing: { input: 2, output: 10, cachedInput: 0.5 },
            },
          },
          embeddingModels: {
            default: {
              model: origEmbed,
              pricing: { input: 0.1 },
            },
          },
        }),
      ],
    });
    overrideModels(builder, { default: replacement });
    overrideEmbeddingModels(builder, { default: replEmbed });

    const mod = await builder.compile();
    const ai = mod.get(AiService);

    const textRes = await ai.generateText({ prompt: 'test' });
    expect(textRes.text).toBe('replaced');
    // 800k uncached * 2 + 200k cached * 0.5 + 500k output * 10 = 1.6 + 0.1 + 5.0 = 6.7
    expect(textRes.cost).toBeCloseTo(6.7, 6);

    const embedRes = await ai.embed({ value: 'hello world' });
    expect(embedRes.value).toBe('hello world');
    expect(embedRes.embedding).toEqual([0.5, 0.6]);
    expect(embedRes.cost).toBeCloseTo(0.1, 6);
    expect(embedRes.attempts).toBe(1);
  });

  it('validates configuration errors (empty registry, bad fallback, both prompt & messages)', async () => {
    expect(
      () => new AiModels({}),
    ).toThrow(AiConfigurationError);

    expect(
      () =>
        new AiModels({
          models: { default: { model: fakeModel('x'), fallback: 'nope' } },
        }),
    ).toThrow(AiConfigurationError);

    const mod = await Test.createTestingModule({
      imports: [AiModule.forRoot({ models: { default: fakeModel('ok') } })],
    }).compile();
    const ai = mod.get(AiService);

    await expect(
      ai.generateText({ prompt: 'a', messages: [{ role: 'user', content: 'b' }] }),
    ).rejects.toBeInstanceOf(AiConfigurationError);
  });

  it('generateObject validates with Standard Schema v1 and throws AiOutputError without retrying', async () => {
    const schema = makeObjectSchema<{ title: string; priority: number }>(
      {
        type: 'object',
        properties: { title: { type: 'string' }, priority: { type: 'number' } },
        required: ['title', 'priority'],
      },
      (val) => {
        if (
          typeof val === 'object' &&
          val !== null &&
          typeof (val as any).title === 'string' &&
          typeof (val as any).priority === 'number'
        ) {
          return { value: val as { title: string; priority: number } };
        }
        return {
          issues: [{ message: 'expected title (string) and priority (number)', path: ['priority'] }],
        };
      },
    );

    const primary = fakeModel(
      { object: { title: 'Bug', priority: 1 } },
      { text: '{"title":"Bug","priority":"high"}' },
      { text: 'not json at all' },
    );
    const backup = fakeModel({ object: { title: 'Backup', priority: 2 } });

    const mod = await Test.createTestingModule({
      imports: [
        AiModule.forRoot({
          models: {
            default: { model: primary, fallback: 'backup', retry: { attempts: 3, backoff: { delay: 1 } } },
            backup,
          },
        }),
      ],
    }).compile();
    const ai = mod.get(AiService);

    const ok = await ai.generateObject({
      prompt: 'triage',
      schema,
      schemaName: 'Triage',
    });
    expect(ok.object).toEqual({ title: 'Bug', priority: 1 });

    await expect(
      ai.generateObject({ prompt: 'triage', schema }),
    ).rejects.toBeInstanceOf(AiOutputError);
    // AiOutputError must NOT trigger retry or fallback
    expect(backup.calls.length).toBe(0);

    try {
      await ai.generateObject({ prompt: 'triage', schema });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AiOutputError);
      expect((err as AiOutputError).text).toBe('not json at all');
    }
    expect(primary.calls.length).toBe(3);
  });

  it('retries transient provider errors, falls back across models, enforces budgets, and publishes usage events + diagnostics_channel', async () => {
    const usageEvents: AiUsageEvent[] = [];
    const callEvents: AiUsageEvent[] = [];
    const channelEvents: unknown[] = [];
    const onChannel = (msg: unknown) => channelEvents.push(msg);
    subscribe('bunest:ai:usage', onChannel);

    try {
      const primary = fakeModel(
        providerError(503, { message: 'overloaded' }),
        'recovered',
        providerError(429, { message: 'rate limited', retryAfter: 0.005 }),
        providerError(500, { message: 'still down' }),
      );
      const fallback = fakeModel('from-fallback');

      const mod = await Test.createTestingModule({
        imports: [
          ResilienceModule.forRoot({
            presets: {
              fast: { retry: { attempts: 2, backoff: { delay: 1, jitter: 'none' } } },
            },
          }),
          AiModule.forRoot({
            models: {
              default: {
                model: primary,
                fallback: 'backup',
                retry: { attempts: 2, backoff: { delay: 1, jitter: 'none' } },
              },
              backup: fallback,
            },
            onUsage: (ev) => {
              usageEvents.push(ev);
            },
          }),
        ],
      }).compile();

      const ai = mod.get(AiService);

      // 1. Retry succeeds on attempt 2
      const r1 = await ai.generateText({
        prompt: 'first',
        label: 'test-retry',
        onUsage: (ev) => {
          callEvents.push(ev);
        },
      });
      expect(r1.text).toBe('recovered');
      expect(r1.steps[0]?.attempts).toBe(2);
      expect(usageEvents.length).toBe(1);
      expect(callEvents.length).toBe(1);
      expect(usageEvents[0]?.attempt).toBe(2);
      expect(usageEvents[0]?.fallback).toBe(false);
      expect(usageEvents[0]?.label).toBe('test-retry');
      expect(channelEvents.length).toBe(1);

      // 2. Exhausts retries on primary -> falls back to backup using preset
      const r2 = await ai.generateText({
        prompt: 'second',
        resilience: 'fast',
      });
      expect(r2.text).toBe('from-fallback');
      expect(r2.model.name).toBe('backup');
      expect(usageEvents[1]?.fallback).toBe(true);

      // 3. All models fail -> AiModelError with attempts
      const alwaysFail = fakeModel(providerError(400, { message: 'bad req' }));
      try {
        await ai.generateText({
          model: alwaysFail,
          prompt: 'fail',
          retry: false,
        });
        throw new Error('expected AiModelError');
      } catch (err) {
        expect(err).toBeInstanceOf(AiModelError);
        expect(err).toBeInstanceOf(AiError);
        expect((err as AiModelError).attempts.length).toBe(1);
      }

      // 4. Budget exceeded
      await expect(
        ai.generateText({
          model: fakeModel('x'),
          prompt: 'over budget',
          budget: { maxTokens: 0 },
        }),
      ).rejects.toBeInstanceOf(AiBudgetExceededError);
    } finally {
      unsubscribe('bunest:ai:usage', onChannel);
    }
  });

  it('embedMany batches respecting maxEmbeddingsPerCall, retries, and emits embedding usage events', async () => {
    const events: AiEmbeddingUsageEvent[] = [];
    const embedder = new FakeEmbeddingModel(
      [
        providerError(503, { message: 'transient' }),
        { embeddings: [[1, 0], [0, 1]], usage: { tokens: 20 }, warnings: ['w1'] },
        { embeddings: [[1, 1]], usage: { tokens: 10 }, response: { headers: { 'x-id': '2' } } },
      ],
      { maxEmbeddingsPerCall: 2, supportsParallelCalls: false },
    );

    const mod = await Test.createTestingModule({
      imports: [
        AiModule.forRoot({
          embeddingModels: {
            default: {
              model: embedder,
              pricing: { input: 100 },
              retry: { attempts: 3, backoff: { delay: 1, jitter: 'none' } },
            },
          },
          onEmbeddingUsage: (ev) => {
            events.push(ev);
          },
        }),
      ],
    }).compile();

    const ai = mod.get(AiService);
    const res = await ai.embedMany({
      values: ['a', 'b', 'c'],
      label: 'batch-docs',
    });

    expect(res.values).toEqual(['a', 'b', 'c']);
    expect(res.embeddings).toEqual([[1, 0], [0, 1], [1, 1]]);
    expect(res.usage).toEqual({ tokens: 30 });
    expect(res.warnings).toEqual(['w1']);
    expect(res.responses).toEqual([{ headers: { 'x-id': '2' } }]);
    expect(res.attempts).toBe(3);
    expect(embedder.doEmbedCalls.length).toBe(3);
    expect(events.length).toBe(1);
    expect(events[0]?.operation).toBe('embedMany');
    expect(events[0]?.inputCount).toBe(3);
    expect(events[0]?.label).toBe('batch-docs');
  });
});
