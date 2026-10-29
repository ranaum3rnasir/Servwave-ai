import { describe, it, expect } from 'vitest';
import { toMessages, toTools, fromResponse } from '../services/copilot/groq-generate';
import type { GeminiContent } from '../services/copilot/gemini-generate';

// The Groq adapter only ever moves between the browser's Gemini dialect and the
// OpenAI chat-completions dialect. If these pure translators are right, the live
// call is just transport — so this is where the real coverage lives.

describe('toMessages: Gemini contents → OpenAI messages', () => {
  it('prepends the system instruction and maps a plain user turn', () => {
    const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: 'How many jobs today?' }] }];
    expect(toMessages(contents, 'You are Servy.')).toEqual([
      { role: 'system', content: 'You are Servy.' },
      { role: 'user', content: 'How many jobs today?' },
    ]);
  });

  it('maps a model functionCall turn to an assistant tool_calls message', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { id: 'call_x', name: 'query_crm', args: { resource: 'jobs' } } }] },
    ];
    const msgs = toMessages(contents, 'sys');
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'query_crm', arguments: '{"resource":"jobs"}' } }],
    });
  });

  it('round-trips a tool result: functionResponse → tool message keyed by the same id', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { id: 'call_x', name: 'query_crm', args: { resource: 'jobs' } } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_x', name: 'query_crm', response: { output: '3 jobs' } } }] },
    ];
    const msgs = toMessages(contents, 'sys');
    // assistant tool_call id and the tool message's tool_call_id must match.
    expect(msgs[1].tool_calls?.[0].id).toBe('call_x');
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'call_x', content: '3 jobs' });
  });

  it('synthesizes a stable id when a model functionCall lacks one', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'get_briefing' } }] },
    ];
    expect(toMessages(contents, 'sys')[1].tool_calls?.[0].id).toBe('call_0');
  });

  it('emits tool results before user text within a single turn', () => {
    const contents: GeminiContent[] = [
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'c1', name: 'query_crm', response: { output: 'done' } } },
          { text: 'and now create a lead' },
        ],
      },
    ];
    const msgs = toMessages(contents, 'sys');
    expect(msgs.map((m) => m.role)).toEqual(['system', 'tool', 'user']);
  });

  it('keeps model text alongside tool calls and tolerates missing/garbage parts', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ text: 'one sec' }, { functionCall: { id: 'c2', name: 'create_job' } }] },
      { role: 'user', parts: [null as unknown as object, 42 as unknown as object] },
    ];
    const msgs = toMessages(contents, 'sys');
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'one sec' });
    expect(msgs[1].tool_calls?.[0].function.arguments).toBe('{}'); // no args → empty object, never undefined
    // a junk-only user turn produces neither a tool nor a user message
    expect(msgs).toHaveLength(2);
  });
});

describe('toTools: functionDeclarations → OpenAI tools', () => {
  it('flattens declarations and renames parametersJsonSchema → parameters', () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'query_crm',
            description: 'Look up records.',
            parametersJsonSchema: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'] },
          },
        ],
      },
    ];
    expect(toTools(tools)).toEqual([
      {
        type: 'function',
        function: {
          name: 'query_crm',
          description: 'Look up records.',
          parameters: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'] },
        },
      },
    ]);
  });

  it('returns [] for missing/empty tools and defaults a missing schema to an object', () => {
    expect(toTools(undefined)).toEqual([]);
    expect(toTools([])).toEqual([]);
    expect(toTools([{ functionDeclarations: [{ name: 'noargs' }] }])[0].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('fromResponse: OpenAI completion → { text, functionCalls }', () => {
  it('extracts assistant text', () => {
    const json = { choices: [{ message: { role: 'assistant', content: 'You have 3 jobs.' } }] };
    expect(fromResponse(json)).toEqual({ text: 'You have 3 jobs.', functionCalls: [] });
  });

  it('parses tool_calls into Gemini-shaped functionCalls', () => {
    const json = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'create_lead', arguments: '{"name":"Jane"}' } }],
          },
        },
      ],
    };
    expect(fromResponse(json)).toEqual({
      text: '',
      functionCalls: [{ id: 'call_9', name: 'create_lead', args: { name: 'Jane' } }],
    });
  });

  it('never throws on malformed tool arguments — falls back to empty args', () => {
    const json = {
      choices: [{ message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{bad json' } }] } }],
    };
    expect(fromResponse(json).functionCalls[0].args).toEqual({});
  });

  it('survives an empty/garbage response shape', () => {
    expect(fromResponse({})).toEqual({ text: '', functionCalls: [] });
    expect(fromResponse(null)).toEqual({ text: '', functionCalls: [] });
  });
});
