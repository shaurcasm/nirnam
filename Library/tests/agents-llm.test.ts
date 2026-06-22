/**
 * Unit tests for agents/llm-client.ts.
 *
 * All HTTP calls go through a mocked global.fetch — no real network calls are made.
 * Tests cover: mock path, OpenAI-compat normalization, Anthropic normalization,
 * SSE streaming (OpenAI + Anthropic), error handling.
 */

jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import { callLLM, callLLMStream } from '../src/agents/llm-client';
import { isMockLLM, detectProvider } from '../src/agents/types';
import { mockLLM } from '../src/agents-testing';
import type { InternalMessage, ToolDefinition, LLMResponse } from '../src/agents/types';

// ---- Global fetch mock -------------------------------------------------------

const mockFetch = jest.fn();
(global as unknown as Record<string, unknown>).fetch = mockFetch;

// ---- Helpers -----------------------------------------------------------------

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    body: null,
  } as unknown as Response;
}

function makeErrorResponse(status: number, text: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => { throw new Error(); },
    text: async () => text,
    body: null,
  } as unknown as Response;
}

function makeSseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(encoder.encode(lines[i++] + '\n'));
      } else {
        controller.close();
      }
    },
  });
}

function makeStreamResponse(lines: string[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => { throw new Error('not JSON'); },
    text: async () => '',
    body: makeSseStream(lines),
  } as unknown as Response;
}

async function collectStream(gen: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

// ---- Fixtures ----------------------------------------------------------------

const simpleMessages: InternalMessage[] = [
  { role: 'user', content: 'Hello' },
];

const messagesWithSystem: InternalMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Summarize this.' },
];

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'echo',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (args) => String(args.text),
};

const openAITextResponse = {
  choices: [{ message: { role: 'assistant', content: 'Hi there!' }, finish_reason: 'stop' }],
  usage: { total_tokens: 20 },
};

const openAIToolCallResponse = {
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: '{"text":"world"}' } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { total_tokens: 30 },
};

const anthropicTextResponse = {
  content: [{ type: 'text', text: 'Anthropic reply.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 20 },
};

const anthropicToolUseResponse = {
  content: [{ type: 'tool_use', id: 'tu1', name: 'echo', input: { text: 'world' } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 15, output_tokens: 5 },
};

const openAIConfig = { url: 'http://localhost:11434/v1', model: 'llama3', apiKey: 'test-key' };
const anthropicConfig = { url: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', apiKey: 'ant-key' };

beforeEach(() => {
  mockFetch.mockReset();
});

// ---- isMockLLM / detectProvider types.ts ------------------------------------

describe('isMockLLM()', () => {
  it('returns true for MockLLMConfig', () => {
    expect(isMockLLM({ _isMock: true })).toBe(true);
  });

  it('returns false for RealLLMConfig', () => {
    expect(isMockLLM({ url: 'http://localhost', model: 'm' })).toBe(false);
  });
});

describe('detectProvider()', () => {
  it('returns "openai-compat" for generic URLs', () => {
    expect(detectProvider({ url: 'http://localhost:11434', model: 'm' })).toBe('openai-compat');
  });

  it('returns "anthropic" when URL contains "anthropic.com"', () => {
    expect(detectProvider({ url: 'https://api.anthropic.com', model: 'm' })).toBe('anthropic');
  });

  it('respects explicit provider override', () => {
    expect(detectProvider({ url: 'http://whatever', model: 'm', provider: 'anthropic' })).toBe('anthropic');
    expect(detectProvider({ url: 'https://api.anthropic.com', model: 'm', provider: 'openai-compat' })).toBe('openai-compat');
  });
});

// ---- callLLM — mock path ---------------------------------------------------

describe('callLLM() — mock LLM', () => {
  it('returns static response without fetch', async () => {
    const result = await callLLM(mockLLM({ response: 'hello' }), simpleMessages, []);
    expect(result.content).toBe('hello');
    expect(result.toolCalls).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns tool calls on first turn (no tool results in history)', async () => {
    const llm = mockLLM({ toolCalls: [{ name: 'echo', args: { text: 'x' } }] });
    const result = await callLLM(llm, simpleMessages, [echoTool]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('echo');
    expect(result.finishReason).toBe('tool_calls');
  });

  it('returns afterToolCalls response when tool results are present', async () => {
    const llm = mockLLM({ toolCalls: [{ name: 'echo', args: {} }], afterToolCalls: 'Done!' });
    const messagesWithToolResult: InternalMessage[] = [
      ...simpleMessages,
      { role: 'assistant', content: null, toolCalls: [{ id: 'tc1', name: 'echo', args: {} }] },
      { role: 'tool', content: 'result', toolCallId: 'tc1', toolName: 'echo' },
    ];
    const result = await callLLM(llm, messagesWithToolResult, []);
    expect(result.content).toBe('Done!');
    expect(result.toolCalls).toHaveLength(0);
  });

  it('invokes custom handler with the full message array', async () => {
    const handler = jest.fn((): LLMResponse => ({ content: 'custom', toolCalls: [], finishReason: 'stop' }));
    const llm = mockLLM({ handler });
    await callLLM(llm, simpleMessages, []);
    expect(handler).toHaveBeenCalledWith(simpleMessages);
  });

  it('returns default response when no options given', async () => {
    const result = await callLLM(mockLLM(), simpleMessages, []);
    expect(typeof result.content).toBe('string');
  });
});

// ---- callLLM — OpenAI-compat -----------------------------------------------

describe('callLLM() — OpenAI-compat', () => {
  it('sends POST to /chat/completions', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    await callLLM(openAIConfig, simpleMessages, []);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('includes Authorization header when apiKey is provided', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    await callLLM(openAIConfig, simpleMessages, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
  });

  it('omits Authorization header when no apiKey', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    await callLLM({ url: 'http://localhost:11434/v1', model: 'llama3' }, simpleMessages, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('includes tools array in body when tools are provided', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    await callLLM(openAIConfig, simpleMessages, [echoTool]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toBeDefined();
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('echo');
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools field when tools array is empty', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    await callLLM(openAIConfig, simpleMessages, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toBeUndefined();
  });

  it('parses text response correctly', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    const result = await callLLM(openAIConfig, simpleMessages, []);
    expect(result.content).toBe('Hi there!');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.finishReason).toBe('stop');
    expect(result.tokensUsed).toBe(20);
  });

  it('parses tool_call response and JSON-decodes arguments', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(openAIToolCallResponse));
    const result = await callLLM(openAIConfig, simpleMessages, [echoTool]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('tc1');
    expect(result.toolCalls[0].name).toBe('echo');
    expect(result.toolCalls[0].args).toEqual({ text: 'world' });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('handles malformed tool_call JSON arguments gracefully', async () => {
    const badResponse = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: 'NOT JSON' } }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    mockFetch.mockResolvedValue(makeJsonResponse(badResponse));
    const result = await callLLM(openAIConfig, simpleMessages, [echoTool]);
    expect(result.toolCalls[0].args).toEqual({});
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500, 'Internal Server Error'));
    await expect(callLLM(openAIConfig, simpleMessages, [])).rejects.toThrow(/LLM request failed/);
  });

  it('includes model in request body', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    await callLLM(openAIConfig, simpleMessages, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('llama3');
  });

  it('normalises messages: tool result messages become role "tool" with tool_call_id', async () => {
    const msgsWithToolResult: InternalMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'tc1', name: 'echo', args: {} }] },
      { role: 'tool', content: 'result', toolCallId: 'tc1', toolName: 'echo' },
    ];
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    await callLLM(openAIConfig, msgsWithToolResult, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('tc1');
  });

  it('maps finish_reason "length" to "length"', async () => {
    const resp = { choices: [{ message: { role: 'assistant', content: 'cut' }, finish_reason: 'length' }] };
    mockFetch.mockResolvedValue(makeJsonResponse(resp));
    const result = await callLLM(openAIConfig, simpleMessages, []);
    expect(result.finishReason).toBe('length');
  });

  it('normalises trailing slash in URL', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    await callLLM({ ...openAIConfig, url: 'http://localhost:11434/v1/' }, simpleMessages, []);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
  });
});

// ---- callLLM — Anthropic ---------------------------------------------------

describe('callLLM() — Anthropic', () => {
  it('sends POST to /v1/messages', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    await callLLM(anthropicConfig, simpleMessages, []);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('uses x-api-key header (not Authorization)', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    await callLLM(anthropicConfig, simpleMessages, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ant-key');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('extracts system message to top-level "system" field', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    await callLLM(anthropicConfig, messagesWithSystem, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('You are helpful.');
    expect(body.messages.some((m: { role: string }) => m.role === 'system')).toBe(false);
  });

  it('batches consecutive tool result messages into one user message with content array', async () => {
    const msgsWithTwoTools: InternalMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, toolCalls: [
        { id: 'tc1', name: 'echo', args: {} },
        { id: 'tc2', name: 'echo', args: {} },
      ]},
      { role: 'tool', content: 'res1', toolCallId: 'tc1', toolName: 'echo' },
      { role: 'tool', content: 'res2', toolCallId: 'tc2', toolName: 'echo' },
    ];
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    await callLLM(anthropicConfig, msgsWithTwoTools, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const toolResultMsg = body.messages.find(
      (m: { role: string; content: unknown[] }) => Array.isArray(m.content) &&
        m.content.some((c: { type: string }) => c.type === 'tool_result')
    );
    expect(toolResultMsg?.role).toBe('user');
    expect(toolResultMsg?.content).toHaveLength(2);
  });

  it('includes max_tokens in body', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    await callLLM(anthropicConfig, simpleMessages, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(4096);
  });

  it('includes tools as input_schema format', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    await callLLM(anthropicConfig, simpleMessages, [echoTool]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools[0].input_schema).toBeDefined();
    expect(body.tools[0].name).toBe('echo');
  });

  it('parses text response correctly', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    const result = await callLLM(anthropicConfig, simpleMessages, []);
    expect(result.content).toBe('Anthropic reply.');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.finishReason).toBe('stop');
    expect(result.tokensUsed).toBe(30);
  });

  it('parses tool_use response correctly', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicToolUseResponse));
    const result = await callLLM(anthropicConfig, simpleMessages, [echoTool]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('tu1');
    expect(result.toolCalls[0].name).toBe('echo');
    expect(result.toolCalls[0].args).toEqual({ text: 'world' });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('maps stop_reason "max_tokens" to finishReason "length"', async () => {
    const resp = {
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 4096 },
    };
    mockFetch.mockResolvedValue(makeJsonResponse(resp));
    const result = await callLLM(anthropicConfig, simpleMessages, []);
    expect(result.finishReason).toBe('length');
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(401, 'Unauthorized'));
    await expect(callLLM(anthropicConfig, simpleMessages, [])).rejects.toThrow(/Anthropic request failed/);
  });

  it('does not send system field when no system message is present', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    await callLLM(anthropicConfig, simpleMessages, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toBeUndefined();
  });

  it('accepts explicit /v1/messages URL without double-appending', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    await callLLM({ ...anthropicConfig, url: 'https://api.anthropic.com/v1/messages' }, simpleMessages, []);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });
});

// ---- callLLMStream — mock path ---------------------------------------------

describe('callLLMStream() — mock LLM', () => {
  it('yields the response string as a single chunk', async () => {
    const chunks = await collectStream(callLLMStream(mockLLM({ response: 'streamed!' }), simpleMessages));
    expect(chunks).toEqual(['streamed!']);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('yields afterToolCalls when response is absent', async () => {
    const chunks = await collectStream(
      callLLMStream(mockLLM({ afterToolCalls: 'after', toolCalls: [{ name: 'x', args: {} }] }), simpleMessages),
    );
    expect(chunks).toEqual(['after']);
  });

  it('yields default mock response when neither response nor afterToolCalls given', async () => {
    const chunks = await collectStream(callLLMStream(mockLLM(), simpleMessages));
    expect(chunks.join('')).toBeTruthy();
  });
});

// ---- callLLMStream — OpenAI SSE streaming ----------------------------------

describe('callLLMStream() — OpenAI-compat SSE', () => {
  it('yields text delta chunks', async () => {
    const sseLines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' World' }, finish_reason: null }] })}`,
      'data: [DONE]',
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));

    const chunks = await collectStream(callLLMStream(openAIConfig, simpleMessages));
    expect(chunks).toEqual(['Hello', ' World']);
  });

  it('stops at [DONE] sentinel', async () => {
    const sseLines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'chunk' } }] })}`,
      'data: [DONE]',
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'after done' } }] })}`,
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));

    const chunks = await collectStream(callLLMStream(openAIConfig, simpleMessages));
    expect(chunks).not.toContain('after done');
    expect(chunks).toContain('chunk');
  });

  it('skips non-data lines silently', async () => {
    const sseLines = [
      'event: message',
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}`,
      'data: [DONE]',
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));

    const chunks = await collectStream(callLLMStream(openAIConfig, simpleMessages));
    expect(chunks).toEqual(['OK']);
  });

  it('skips malformed JSON SSE lines', async () => {
    const sseLines = [
      'data: NOT_JSON',
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'valid' } }] })}`,
      'data: [DONE]',
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));

    const chunks = await collectStream(callLLMStream(openAIConfig, simpleMessages));
    expect(chunks).toContain('valid');
  });

  it('throws on non-200 stream response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'fail', body: null } as unknown as Response);
    await expect(collectStream(callLLMStream(openAIConfig, simpleMessages))).rejects.toThrow(/LLM stream failed/);
  });

  it('sends stream: true in request body', async () => {
    const sseLines = ['data: [DONE]'];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));
    await collectStream(callLLMStream(openAIConfig, simpleMessages));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
  });
});

// ---- callLLMStream — Anthropic SSE streaming --------------------------------

describe('callLLMStream() — Anthropic SSE', () => {
  it('yields text_delta chunks from content_block_delta events', async () => {
    const sseLines = [
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' Claude' } })}`,
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));

    const chunks = await collectStream(callLLMStream(anthropicConfig, simpleMessages));
    expect(chunks).toEqual(['Hello', ' Claude']);
  });

  it('stops at message_stop event', async () => {
    const sseLines = [
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before stop' } })}`,
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'after stop' } })}`,
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));

    const chunks = await collectStream(callLLMStream(anthropicConfig, simpleMessages));
    expect(chunks).toContain('before stop');
    expect(chunks).not.toContain('after stop');
  });

  it('throws on non-200 stream response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden', body: null } as unknown as Response);
    await expect(collectStream(callLLMStream(anthropicConfig, simpleMessages))).rejects.toThrow(/Anthropic stream failed/);
  });

  it('uses x-api-key header and anthropic-version for streaming', async () => {
    const sseLines = [`data: ${JSON.stringify({ type: 'message_stop' })}`];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));
    await collectStream(callLLMStream(anthropicConfig, simpleMessages));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ant-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('skips malformed JSON lines', async () => {
    const sseLines = [
      'data: {BROKEN',
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })}`,
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));
    const chunks = await collectStream(callLLMStream(anthropicConfig, simpleMessages));
    expect(chunks).toContain('ok');
  });

  it('uses URL as-is when it already contains /v1/messages', async () => {
    const sseLines = [`data: ${JSON.stringify({ type: 'message_stop' })}`];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));
    await collectStream(callLLMStream(
      { ...anthropicConfig, url: 'https://api.anthropic.com/v1/messages' },
      simpleMessages,
    ));
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('skips content_block_delta with empty text (falsy chunk branch)', async () => {
    const sseLines = [
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'real' } })}`,
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));
    const chunks = await collectStream(callLLMStream(anthropicConfig, simpleMessages));
    expect(chunks).toEqual(['real']); // empty text is skipped
  });
});

// ---- Additional branch coverage for llm-client.ts --------------------------

describe('additional branch coverage', () => {
  it('callLLM Anthropic: assistant message with BOTH text content and tool_use blocks', async () => {
    const messagesWithAssistantTextAndTools: import('../src/agents/types').InternalMessage[] = [
      { role: 'user', content: 'call the tool' },
      {
        role: 'assistant',
        content: 'Sure, calling it now.',
        toolCalls: [{ id: 'tc1', name: 'echo', args: { text: 'x' } }],
      },
      { role: 'tool', content: 'done', toolCallId: 'tc1', toolName: 'echo' },
    ];
    mockFetch.mockResolvedValue(makeJsonResponse(anthropicTextResponse));
    await callLLM(anthropicConfig, messagesWithAssistantTextAndTools, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const assistantMsg = body.messages.find((m: { role: string; content: unknown[] }) =>
      m.role === 'assistant' && Array.isArray(m.content)
    );
    // Both 'text' and 'tool_use' content blocks should be present
    expect(assistantMsg?.content.some((c: { type: string }) => c.type === 'text')).toBe(true);
    expect(assistantMsg?.content.some((c: { type: string }) => c.type === 'tool_use')).toBe(true);
  });

  it('callLLM Anthropic: response without usage returns tokensUsed undefined', async () => {
    const noUsageResponse = {
      content: [{ type: 'text', text: 'reply' }],
      stop_reason: 'end_turn',
      // no usage field
    };
    mockFetch.mockResolvedValue(makeJsonResponse(noUsageResponse));
    const result = await callLLM(anthropicConfig, simpleMessages, []);
    expect(result.tokensUsed).toBeUndefined();
  });

  it('callLLMStream OpenAI: throws when body is null (not ok or no body)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      text: async () => '',
    } as unknown as Response);
    await expect(collectStream(callLLMStream(openAIConfig, simpleMessages))).rejects.toThrow(/LLM stream failed/);
  });

  it('callLLM OpenAI: assistant with null content returns null content in response', async () => {
    const nullContentResponse = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    mockFetch.mockResolvedValue(makeJsonResponse(nullContentResponse));
    const result = await callLLM(openAIConfig, simpleMessages, [echoTool]);
    expect(result.content).toBeNull();
    expect(result.toolCalls[0].name).toBe('echo');
  });

  it('callLLM OpenAI: toOpenAIMessages serialises assistant with string content AND tool calls', async () => {
    const msgsWithAssistantContentAndTools: import('../src/agents/types').InternalMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'Sure, I will do that.',
        toolCalls: [{ id: 'tc1', name: 'echo', args: { text: 'hi' } }],
      },
      { role: 'tool', content: 'result', toolCallId: 'tc1', toolName: 'echo' },
    ];
    mockFetch.mockResolvedValue(makeJsonResponse(openAITextResponse));
    await callLLM(openAIConfig, msgsWithAssistantContentAndTools, []);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const assistantMsg = body.messages.find(
      (m: { role: string; tool_calls?: unknown[] }) => m.role === 'assistant' && m.tool_calls,
    );
    expect(assistantMsg?.content).toBe('Sure, I will do that.');
    expect(assistantMsg?.tool_calls).toHaveLength(1);
  });

  it('callLLMStream OpenAI: uses explicit /v1/messages URL as-is', async () => {
    const sseLines = ['data: [DONE]'];
    mockFetch.mockResolvedValue(makeStreamResponse(sseLines));
    await collectStream(callLLMStream(
      { ...openAIConfig, url: 'http://localhost:11434/v1/' },
      simpleMessages,
    ));
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
  });
});
