import { describe, it, expect, vi } from 'vitest';
import { runConversationTurn } from '@/components/copilot/tools/conversationLoop';
import type { GeminiContent } from '@/lib/copilot/api';
import type { ToolOutcome } from '@/components/copilot/tools/toolHandlers';
import type { PreparedAction } from '@/components/copilot/tools/approval';

// The loop treats the prepared action opaquely (it only stores it), so a stub is fine.
const fakeAction = { toolName: 'create_lead', summary: 'Create a lead' } as unknown as PreparedAction;

const hasFnResponse = (c: GeminiContent) => c.parts.some((p) => p && typeof p === 'object' && 'functionResponse' in p);

describe('runConversationTurn', () => {
  it('returns the reply and stops when the model makes no tool call', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'You have 4 jobs today.', functionCalls: [] });
    const executeTool = vi.fn();
    const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: 'jobs?' }] }];

    const result = await runConversationTurn(contents, [], { generate, executeTool });

    expect(result.assistantText).toBe('You have 4 jobs today.');
    expect(result.pending).toBeNull();
    expect(executeTool).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(contents[contents.length - 1]).toEqual({ role: 'model', parts: [{ text: 'You have 4 jobs today.' }] });
  });

  it('executes a read tool, feeds the result back, then answers', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: '', functionCalls: [{ name: 'query_crm', args: { resource: 'jobs' } }] })
      .mockResolvedValueOnce({ text: 'You have 4 jobs.', functionCalls: [] });
    const executeTool = vi.fn().mockResolvedValue({ kind: 'immediate', output: '4 jobs' } as ToolOutcome);
    const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: 'jobs?' }] }];

    const result = await runConversationTurn(contents, [], { generate, executeTool });

    expect(executeTool).toHaveBeenCalledWith('query_crm', { resource: 'jobs' });
    expect(result.assistantText).toBe('You have 4 jobs.');
    expect(result.pending).toBeNull();
    expect(contents.some(hasFnResponse)).toBe(true);
  });

  it('prepares a write as a pending approval, voicing the tool speak without a second generate', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: '', functionCalls: [{ name: 'create_lead', args: { service_request: 'AC' } }] });
    const executeTool = vi
      .fn()
      .mockResolvedValue({ kind: 'approval', action: fakeAction, speak: 'prepared, confirm?' } as ToolOutcome);
    const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: 'add a lead' }] }];

    const result = await runConversationTurn(contents, [], { generate, executeTool });

    expect(result.pending?.action).toBe(fakeAction);
    // The confirm line comes straight from the tool's `speak` — no extra model round.
    expect(result.assistantText).toBe('prepared, confirm?');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('refuses a second write while one is already pending in the same batch', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        text: '',
        functionCalls: [
          { name: 'create_lead', args: {} },
          { name: 'create_estimate', args: {} },
        ],
      })
      .mockResolvedValueOnce({ text: 'prepared one — confirm?', functionCalls: [] });
    const executeTool = vi
      .fn()
      .mockResolvedValue({ kind: 'approval', action: fakeAction, speak: 'prepared, confirm?' } as ToolOutcome);
    const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: 'do two things' }] }];

    const result = await runConversationTurn(contents, [], { generate, executeTool });

    // Only the FIRST write ran; the second was refused without a second execution.
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.pending?.action).toBe(fakeAction);
    const refusalTurn = contents.find((c) => c.role === 'user' && c.parts.length === 2 && c.parts.every((p) => 'functionResponse' in (p as object)));
    expect(refusalTurn).toBeTruthy();
  });

  it('stops after maxRounds if the model keeps calling tools', async () => {
    const generate = vi.fn().mockResolvedValue({ text: '', functionCalls: [{ name: 'query_crm', args: {} }] });
    const executeTool = vi.fn().mockResolvedValue({ kind: 'immediate', output: 'data' } as ToolOutcome);
    const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: 'loop forever' }] }];

    const result = await runConversationTurn(contents, [], { generate, executeTool, maxRounds: 3 });

    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.assistantText).toBe('');
    expect(result.pending).toBeNull();
  });
});
