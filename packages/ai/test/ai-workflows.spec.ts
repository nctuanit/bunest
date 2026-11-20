import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { Injectable } from '@bunest/common';
import { Test } from '@bunest/testing';
import {
  Workflow,
  WorkflowClient,
  WorkflowsModule,
  type WorkflowContext,
  type WorkflowRunner,
} from '@bunest/workflows';
import {
  AgentFunction,
  AiConfigurationError,
  AiModule,
  type AgentFunctionContext,
} from '../src/index';
import { fakeModel } from '../src/testing/index';
import {
  AiAgents,
  AiWorkflowsModule,
  TOOL_APPROVAL,
  type AiAgentRunResult,
} from '../src/workflows/index';

describe('@bunest/ai/workflows — Durable Agent Loops & Human Approvals', () => {
  it('runs a durable multi-step agent loop with human-in-the-loop approval, idempotencyKey, and child segment continuation', async () => {
    const executedIdempotencyKeys: string[] = [];
    let refundCalls = 0;

    @Injectable()
    class BillingTools {
      @AgentFunction({ name: 'lookup_order', description: 'Lookup an order' })
      lookup(input: { orderId: string }, ctx: AgentFunctionContext) {
        if (ctx.idempotencyKey) executedIdempotencyKeys.push(ctx.idempotencyKey);
        return { orderId: input.orderId, amount: 50 };
      }

      @AgentFunction({ name: 'issue_refund', description: 'Issue a refund' })
      refund(input: { orderId: string; amount: number }, ctx: AgentFunctionContext) {
        refundCalls++;
        if (ctx.idempotencyKey) executedIdempotencyKeys.push(ctx.idempotencyKey);
        return { refunded: true, orderId: input.orderId, amount: input.amount };
      }
    }

    @Workflow('refund-agent')
    class RefundAgentWorkflow implements WorkflowRunner<{ orderId: string }, AiAgentRunResult> {
      constructor(private readonly agents: AiAgents) {}

      run(ctx: WorkflowContext, input: { orderId: string }): Promise<AiAgentRunResult> {
        return this.agents.run(ctx, {
          prompt: `Process refund for ${input.orderId}`,
          tools: ['lookup_order', 'issue_refund'],
          approve: ['issue_refund'],
          stepsPerInstance: 1, // Forces child AiAgentSegment continuation after step 0!
          maxSteps: 5,
          caller: { user: { id: 'cust_1' } },
        });
      }
    }

    const model = fakeModel(
      // Step 0 (root instance): call lookup_order (no approval needed)
      { toolCalls: [{ name: 'lookup_order', input: { orderId: 'ord_7' }, id: 'tc_lookup' }] },
      // Step 1 (child segment instance): call issue_refund (requires approval!)
      { toolCalls: [{ name: 'issue_refund', input: { orderId: 'ord_7', amount: 50 }, id: 'tc_refund' }] },
      // Step 2 (grandchild segment instance): final answer
      'Refund of $50 issued for ord_7.',
    );

    const mod = await Test.createTestingModule({
      imports: [
        WorkflowsModule.forRoot({
          worker: { pollInterval: '10ms' },
        }),
        AiModule.forRoot({
          isGlobal: true,
          models: { default: model },
        }),
        AiWorkflowsModule,
      ],
      providers: [BillingTools, RefundAgentWorkflow],
    }).compile();

    await mod.init();
    try {
      const client = mod.get(WorkflowClient);
      const agents = mod.get(AiAgents);

      expect(TOOL_APPROVAL.name).toBe('nestjs-ai.tool-approval');

      const started = await client.start(RefundAgentWorkflow, { orderId: 'ord_7' });

      // Wait until pending approval appears (inside child segment!)
      let pending = await agents.pendingApprovals(started.id);
      const deadline = Date.now() + 5000;
      while (pending.length === 0 && Date.now() < deadline) {
        await Bun.sleep(15);
        pending = await agents.pendingApprovals(started.id);
      }

      expect(pending.length).toBe(1);
      expect(pending[0]?.toolName).toBe('issue_refund');
      expect(pending[0]?.toolCallId).toBe('tc_refund');
      expect(pending[0]?.runId).toBe(started.id);
      expect(refundCalls).toBe(0);

      // Approve the tool call!
      await agents.approve(pending[0]!.key, { by: 'manager_alice' });

      const result = await client.result<AiAgentRunResult>(started.id, { timeout: '5s' });
      expect(result.text).toBe('Refund of $50 issued for ord_7.');
      expect(result.steps.length).toBe(3);
      expect(refundCalls).toBe(1);
      expect(executedIdempotencyKeys.length).toBe(2);
      expect(await agents.pendingApprovals(started.id)).toEqual([]);
    } finally {
      await mod.close();
    }
  });

  it('rejects a pending tool call without running it and tells the model the reason', async () => {
    let called = false;

    @Injectable()
    class DangerTools {
      @AgentFunction({ name: 'delete_all' })
      deleteAll() {
        called = true;
        return { deleted: true };
      }
    }

    @Workflow('danger-agent')
    class DangerAgentWorkflow implements WorkflowRunner<void, AiAgentRunResult> {
      constructor(private readonly agents: AiAgents) {}

      run(ctx: WorkflowContext) {
        return this.agents.run(ctx, {
          prompt: 'Delete everything',
          tools: ['delete_all'],
          approve: ['delete_all'],
        });
      }
    }

    const model = fakeModel(
      { toolCalls: [{ name: 'delete_all', input: {}, id: 'tc_del' }] },
      'Understood, I did not delete anything.',
    );

    const mod = await Test.createTestingModule({
      imports: [
        WorkflowsModule.forRoot({
          worker: { pollInterval: '10ms' },
        }),
        AiModule.forRoot({
          isGlobal: true,
          models: { default: model },
        }),
        AiWorkflowsModule,
      ],
      providers: [DangerTools, DangerAgentWorkflow],
    }).compile();

    await mod.init();
    try {
      const client = mod.get(WorkflowClient);
      const agents = mod.get(AiAgents);

      const started = await client.start(DangerAgentWorkflow, undefined);

      let pending = await agents.pendingApprovals(started.id);
      const deadline = Date.now() + 5000;
      while (pending.length === 0 && Date.now() < deadline) {
        await Bun.sleep(15);
        pending = await agents.pendingApprovals(started.id);
      }
      expect(pending.length).toBe(1);

      await agents.reject(pending[0]!.key, { reason: 'Too risky', by: 'bob' });

      const result = await client.result<AiAgentRunResult>(started.id, { timeout: '5s' });
      expect(called).toBe(false);
      expect(result.text).toBe('Understood, I did not delete anything.');
      expect(result.toolResults[0]?.error).toBe('The call was rejected: Too risky');
      expect(model.calls[1]?.toolResults[0]?.output).toBe('The call was rejected: Too risky');

      // Validate approve option referencing non-listed tool
      expect(() =>
        agents.run({ workflowId: 'w1' } as WorkflowContext, {
          prompt: 'x',
          tools: ['delete_all'],
          approve: ['unknown_tool'],
        }),
      ).toThrow(AiConfigurationError);
    } finally {
      await mod.close();
    }
  });
});
