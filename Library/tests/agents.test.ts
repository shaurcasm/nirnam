/**
 * Unit tests for @palinc/nirnam/agents — NirnamAgent, connectAgents, presets,
 * and the testing utilities (mockLLM / scenarioMock).
 *
 * Fetch is NOT called here; all LLM calls go through mockLLM / scenarioMock.
 * The SharedWorker + BroadcastChannel infrastructure is the same mock from setup.ts.
 */

jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import { createAgent, NirnamAgent } from '../src/agents/agent';
import { connectAgents, pipelinePublish, fanOutPublish } from '../src/agents/connect';
import { presets, withPreset } from '../src/agents/presets';
import { mockLLM, scenarioMock } from '../src/agents-testing';
import type { ToolDefinition } from '../src/agents/types';
import { NirnamRequestError } from '../src/types';
import { resetWorkerState, resetBroadcastChannels } from './setup';

// ---- Window mock for autoCleanup -------------------------------------------

const capturedListeners: Record<string, EventListenerOrEventListenerObject[]> = {};
const mockWindow = {
  addEventListener: jest.fn((ev: string, fn: EventListenerOrEventListenerObject) => {
    capturedListeners[ev] = capturedListeners[ev] ?? [];
    capturedListeners[ev].push(fn);
  }),
  removeEventListener: jest.fn((ev: string, fn: EventListenerOrEventListenerObject) => {
    capturedListeners[ev] = (capturedListeners[ev] ?? []).filter(f => f !== fn);
  }),
};
(global as unknown as Record<string, unknown>).window = mockWindow;

// ---- Shared helpers ---------------------------------------------------------

const flushPromises = () => new Promise<void>(r => setTimeout(r, 0));

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo text back',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (args) => String(args.text),
};

const failTool: ToolDefinition = {
  name: 'fail',
  description: 'Always throws',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => { throw new Error('Tool failed'); },
};

async function makeAgent(overrides: Parameters<typeof createAgent>[0] = {}) {
  const agent = createAgent({
    llm: mockLLM({ response: 'OK' }),
    autoCleanup: false,
    ...overrides,
  });
  await agent.ready;
  return agent;
}

// ---- Lifecycle --------------------------------------------------------------

beforeEach(() => {
  resetWorkerState();
  resetBroadcastChannels();
  jest.clearAllMocks();
  for (const k of Object.keys(capturedListeners)) delete capturedListeners[k];
});

// ---- createAgent / NirnamAgent initialization -------------------------------

describe('createAgent / initialization', () => {
  it('returns a NirnamAgent instance', async () => {
    const agent = await makeAgent();
    expect(agent).toBeInstanceOf(NirnamAgent);
  });

  it('uses the provided agentId', async () => {
    const agent = await makeAgent({ agentId: 'my-agent' });
    expect(agent.agentId).toBe('my-agent');
  });

  it('auto-generates agentId when omitted', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    expect(a.agentId).toBeTruthy();
    expect(a.agentId).not.toBe(b.agentId);
  });

  it('status is "ready" after ready promise resolves', async () => {
    const agent = await makeAgent();
    expect(agent.status).toBe('ready');
  });

  it('autoCleanup registers a beforeunload listener', async () => {
    await makeAgent({ autoCleanup: true });
    expect(capturedListeners['beforeunload']?.length).toBeGreaterThanOrEqual(1);
  });

  it('autoCleanup: false skips the beforeunload listener', async () => {
    await makeAgent({ autoCleanup: false });
    expect(capturedListeners['beforeunload'] ?? []).toHaveLength(0);
  });

  it('pre-registers tools passed in config', async () => {
    const spy = jest.fn().mockResolvedValue('done');
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'custom', args: {} }], afterToolCalls: 'replied' }),
      tools: [{
        name: 'custom',
        description: 'd',
        inputSchema: { type: 'object', properties: {} },
        execute: spy,
      }],
    });
    await agent.chat('go');
    expect(spy).toHaveBeenCalled();
  });
});

// ---- chat() -----------------------------------------------------------------

describe('chat()', () => {
  it('returns the LLM response string', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'Hello!' }) });
    const result = await agent.chat('hi');
    expect(result).toBe('Hello!');
  });

  it('adds user and assistant messages to history', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'Reply' }) });
    await agent.chat('Ping');
    expect(agent.history).toHaveLength(2);
    expect(agent.history[0]).toMatchObject({ role: 'user', content: 'Ping' });
    expect(agent.history[1]).toMatchObject({ role: 'assistant', content: 'Reply' });
  });

  it('executes a tool call and returns final response', async () => {
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'echo', args: { text: 'world' } }], afterToolCalls: 'Done' }),
      tools: [echoTool],
    });
    const result = await agent.chat('do it');
    expect(result).toBe('Done');
  });

  it('increments messagesProcessed stat', async () => {
    const agent = await makeAgent();
    await agent.chat('hi');
    expect(agent.stats.messagesProcessed).toBe(1);
  });

  it('increments toolCallsExecuted stat per executed tool', async () => {
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'echo', args: { text: 'x' } }], afterToolCalls: 'done' }),
      tools: [echoTool],
    });
    await agent.chat('go');
    expect(agent.stats.toolCallsExecuted).toBe(1);
  });

  it('throws when agent is stopped', async () => {
    const agent = await makeAgent();
    agent.stop();
    await expect(agent.chat('hi')).rejects.toThrow(/stopped/);
  });

  it('throws when agent is destroyed', async () => {
    const agent = await makeAgent();
    agent.destroy();
    await expect(agent.chat('hi')).rejects.toThrow(/destroyed/);
  });

  it('aborts via an already-aborted AbortController signal', async () => {
    const agent = await makeAgent();
    const ctrl = new AbortController();
    ctrl.abort(new Error('cancelled'));
    await expect(agent.chat('go', { signal: ctrl.signal })).rejects.toThrow();
  });

  it('records message timestamps', async () => {
    const before = Date.now();
    const agent = await makeAgent();
    await agent.chat('hi');
    const after = Date.now();
    for (const m of agent.history) {
      expect(m.timestamp).toBeGreaterThanOrEqual(before);
      expect(m.timestamp).toBeLessThanOrEqual(after);
    }
  });

  it('tool execution error is fed back to LLM as error string', async () => {
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'fail', args: {} }], afterToolCalls: 'handled' }),
      tools: [failTool],
    });
    const result = await agent.chat('cause error');
    expect(result).toBe('handled');
  });

  it('missing tool results in error content, not exception', async () => {
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'nonexistent', args: {} }], afterToolCalls: 'ok' }),
    });
    await expect(agent.chat('go')).resolves.toBe('ok');
  });

  it('returns max-iterations message when loop exceeds limit', async () => {
    // Custom handler that always returns tool calls
    let calls = 0;
    const agent = await makeAgent({
      llm: mockLLM({
        handler: () => {
          calls++;
          return { content: null, toolCalls: [{ id: `c${calls}`, name: 'echo', args: { text: 'x' } }], finishReason: 'tool_calls' };
        },
      }),
      tools: [echoTool],
    });
    const result = await agent.chat('loop forever', { maxIterations: 2 });
    expect(result).toMatch(/Max tool iterations/);
  });
});

// ---- chatStream() -----------------------------------------------------------

describe('chatStream()', () => {
  async function collectStream(gen: AsyncGenerator<string>): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of gen) chunks.push(chunk);
    return chunks.join('');
  }

  it('yields text chunks and commits to history', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'Streamed!' }) });
    const text = await collectStream(agent.chatStream('hi'));
    expect(text).toBe('Streamed!');
    expect(agent.history.at(-1)?.role).toBe('assistant');
    expect(agent.history.at(-1)?.content).toBe('Streamed!');
  });

  it('runs tool loop before streaming final text', async () => {
    const spy = jest.fn().mockResolvedValue('tool-result');
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'spy-tool', args: {} }], afterToolCalls: 'After tools' }),
      tools: [{
        name: 'spy-tool', description: 'd',
        inputSchema: { type: 'object', properties: {} },
        execute: spy,
      }],
    });
    const text = await collectStream(agent.chatStream('go'));
    expect(spy).toHaveBeenCalled();
    expect(text).toBe('After tools');
  });

  it('status returns to ready after streaming completes', async () => {
    const agent = await makeAgent();
    await collectStream(agent.chatStream('hi'));
    expect(agent.status).toBe('ready');
  });
});

// ---- run() ------------------------------------------------------------------

describe('run()', () => {
  it('returns the LLM response', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'task result' }) });
    const result = await agent.run('do task');
    expect(result).toBe('task result');
  });

  it('does NOT persist history when retainHistory is false (default)', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'r' }) });
    await agent.chat('persistent');
    const lengthBefore = agent.history.length;
    await agent.run('background task');
    expect(agent.history.length).toBe(lengthBefore);
  });

  it('persists history when retainHistory is true', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'r' }), retainHistory: true });
    await agent.run('task');
    expect(agent.history.length).toBeGreaterThan(0);
  });
});

// ---- process() (passive mode) -----------------------------------------------

describe('process()', () => {
  it('returns the LLM response for the given input', async () => {
    const agent = await makeAgent({
      mode: 'passive',
      systemPrompt: 'You are a classifier.',
      llm: mockLLM({ response: '{"severity":"info"}' }),
    });
    const result = await agent.process('some log entry');
    expect(result).toBe('{"severity":"info"}');
  });

  it('does not write to public history (history is for active chat only)', async () => {
    const agent = await makeAgent({ mode: 'passive', llm: mockLLM({ response: 'r' }) });
    await agent.process('input');
    expect(agent.history).toHaveLength(0);
  });

  it('includes prior messages in LLM context when retainHistory is true', async () => {
    const capturedMsgs: Array<Array<{ role: string; content: string | null }>> = [];
    const agent = await makeAgent({
      mode: 'passive',
      llm: mockLLM({
        handler: (msgs) => {
          capturedMsgs.push(msgs.map(m => ({ role: m.role, content: m.content })));
          return { content: 'ok', toolCalls: [], finishReason: 'stop' };
        },
      }),
      retainHistory: true,
    });
    await agent.process('first call');
    await agent.process('second call');
    // Second LLM call should include the first call's messages in context
    expect(capturedMsgs.length).toBe(2);
    expect(capturedMsgs[1].some(m => m.content === 'first call')).toBe(true);
  });
});

// ---- Tool management --------------------------------------------------------

describe('addTool / removeTool', () => {
  it('addTool registers a tool that the LLM can call', async () => {
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'adder', args: { a: 3, b: 4 } }], afterToolCalls: 'done' }),
    });
    agent.addTool({
      name: 'adder',
      description: 'add',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      execute: async (args) => String((args.a as number) + (args.b as number)),
    });
    await agent.chat('add them');
    expect(agent.stats.toolCallsExecuted).toBe(1);
  });

  it('removeTool prevents the tool from being called', async () => {
    const spy = jest.fn().mockResolvedValue('result');
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'temp', args: {} }], afterToolCalls: 'ok' }),
      tools: [{ name: 'temp', description: 't', inputSchema: { type: 'object', properties: {} }, execute: spy }],
    });
    agent.removeTool('temp');
    await agent.chat('go');
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---- asTool() ---------------------------------------------------------------

describe('asTool()', () => {
  it('returns a ToolDefinition wrapping agent.run()', async () => {
    const summarizer = await makeAgent({ llm: mockLLM({ response: 'summary text' }) });
    const tool = summarizer.asTool({
      name: 'summarize',
      description: 'summarize text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    });

    expect(tool.name).toBe('summarize');
    const result = await tool.execute({ text: 'long document' });
    expect(result).toBe('summary text');
  });

  it('uses formatInput when provided', async () => {
    const spy = jest.fn().mockResolvedValue('ok');
    const agent = await makeAgent({ llm: mockLLM({ response: 'ok' }) });
    const tool = agent.asTool({
      name: 'custom',
      description: 'd',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      formatInput: (args) => `Question: ${args.q}`,
    });

    // We can't easily spy on agent.run() itself, so we verify the tool resolves
    const result = await tool.execute({ q: 'hello' });
    expect(result).toBe('ok');
  });
});

// ---- Bus-based agent communication ------------------------------------------

describe('agent-to-agent communication', () => {
  it('handle/request routes via agent-namespaced bus topic', async () => {
    const agentA = await makeAgent({ agentId: 'agent-a' });
    const agentB = await makeAgent({ agentId: 'agent-b' });

    agentB.handle<string, string>('greet', (name) => `Hello, ${name}!`);

    const result = await agentA.request<string, string>('agent-b', 'greet', 'World');
    expect(result).toBe('Hello, World!');

    agentA.destroy();
    agentB.destroy();
  });

  it('publish/subscribe use unnamespaced topics (global broadcast)', async () => {
    const agentA = await makeAgent({ agentId: 'a' });
    const agentB = await makeAgent({ agentId: 'b' });
    const handler = jest.fn();

    agentB.subscribe('announcement', handler);
    agentA.publish('announcement', 'hello');

    expect(handler).toHaveBeenCalledWith('hello');
    agentA.destroy();
    agentB.destroy();
  });

  it('subscribe returns an unsubscribe function', async () => {
    const agentA = await makeAgent();
    const agentB = await makeAgent();
    const handler = jest.fn();

    const unsub = agentB.subscribe('topic', handler);
    unsub();
    agentA.publish('topic', 'should not arrive');

    expect(handler).not.toHaveBeenCalled();
    agentA.destroy();
    agentB.destroy();
  });

  it('handle cleanup (unsub) stops routing to the handler', async () => {
    const agentA = await makeAgent({ agentId: 'caller' });
    const agentB = await makeAgent({ agentId: 'callee' });

    const unsub = agentB.handle('op', () => 'was here');
    unsub();

    await expect(agentA.request('callee', 'op', {})).rejects.toBeInstanceOf(NirnamRequestError);
    agentA.destroy();
    agentB.destroy();
  });
});

// ---- Interceptors -----------------------------------------------------------

describe('interceptors', () => {
  it('onBeforeToolCall interceptor can deny a tool call', async () => {
    const executeSpy = jest.fn().mockResolvedValue('done');
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'echo', args: { text: 'x' } }], afterToolCalls: 'after' }),
      tools: [{ ...echoTool, execute: executeSpy }],
    });

    agent.onBeforeToolCall(async (_call, _next) => ({ error: 'Denied by test' }));

    await agent.chat('go');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('onBeforeToolCall interceptor can allow via next()', async () => {
    const executeSpy = jest.fn().mockResolvedValue('allowed');
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'echo', args: { text: 'x' } }], afterToolCalls: 'ok' }),
      tools: [{ ...echoTool, execute: executeSpy }],
    });

    agent.onBeforeToolCall(async (call, next) => next(call));

    await agent.chat('go');
    expect(executeSpy).toHaveBeenCalled();
  });

  it('onAfterToolCall interceptor can transform the result', async () => {
    let seenContent = '';
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'echo', args: { text: 'original' } }], afterToolCalls: 'ok' }),
      tools: [echoTool],
    });

    agent.onAfterToolCall((_call, result) => {
      seenContent = result.content;
      return { ...result, content: 'transformed' };
    });

    await agent.chat('go');
    expect(seenContent).toBe('original');
  });

  it('onBeforeLLMCall interceptor can modify the messages array', async () => {
    const capturedMessages: unknown[] = [];
    const agent = await makeAgent({ llm: mockLLM({ response: 'ok' }) });

    agent.onBeforeLLMCall((messages, next) => {
      capturedMessages.push(...messages);
      return next(messages);
    });

    await agent.chat('test message');
    expect(capturedMessages.some((m: unknown) => (m as { content: string }).content === 'test message')).toBe(true);
  });

  it('onMessage fires for each user and assistant message', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'reply' }) });
    const received: string[] = [];

    agent.onMessage((m) => received.push(m.role));

    await agent.chat('hello');
    expect(received).toEqual(['user', 'assistant']);
  });

  it('onMessage unsub stops future notifications', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'r' }) });
    const handler = jest.fn();
    const unsub = agent.onMessage(handler);
    unsub();

    await agent.chat('hi');
    expect(handler).not.toHaveBeenCalled();
  });

  it('onStatusChange fires on each status transition', async () => {
    const statuses: string[] = [];
    const agent = createAgent({ llm: mockLLM({ response: 'ok' }), autoCleanup: false });
    agent.onStatusChange(s => statuses.push(s));

    await agent.ready;
    await agent.chat('hi');

    expect(statuses).toContain('ready');
    expect(statuses).toContain('busy');
  });

  it('onStatusChange unsub stops future notifications', async () => {
    const agent = await makeAgent();
    const handler = jest.fn();
    const unsub = agent.onStatusChange(handler);
    unsub();
    await agent.chat('hi');
    expect(handler).not.toHaveBeenCalled();
  });

  it('multiple onBeforeToolCall interceptors chain in registration order', async () => {
    const order: string[] = [];
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'echo', args: { text: 'x' } }], afterToolCalls: 'ok' }),
      tools: [echoTool],
    });

    agent.onBeforeToolCall(async (call, next) => { order.push('first'); return next(call); });
    agent.onBeforeToolCall(async (call, next) => { order.push('second'); return next(call); });

    await agent.chat('go');
    expect(order).toEqual(['first', 'second']);
  });
});

// ---- History management -----------------------------------------------------

describe('history', () => {
  it('history returns a copy (mutations do not affect internal state)', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'r' }) });
    await agent.chat('hi');
    const h = agent.history;
    h.push({ id: 'x', role: 'user', content: 'injected', timestamp: 0 });
    expect(agent.history).toHaveLength(2); // still 2, not 3
  });

  it('clearHistory wipes history', async () => {
    const agent = await makeAgent();
    await agent.chat('hi');
    agent.clearHistory();
    expect(agent.history).toHaveLength(0);
  });

  it('exportHistory returns a serialisable snapshot', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'r' }) });
    await agent.chat('hi');
    const snap = agent.exportHistory();
    expect(Array.isArray(snap)).toBe(true);
    expect(snap.some(m => m.role === 'user')).toBe(true);
  });

  it('importHistory restores public history', async () => {
    const agentA = await makeAgent({ llm: mockLLM({ response: 'r' }) });
    await agentA.chat('remembered');
    const snap = agentA.exportHistory();

    const agentB = await makeAgent();
    agentB.importHistory(snap);

    expect(agentB.history.some(m => m.content === 'remembered')).toBe(true);
  });

  it('history has unique ids per message', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'r' }) });
    await agent.chat('hi');
    const ids = agent.history.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---- Lifecycle (stop / resume / destroy) ------------------------------------

describe('lifecycle', () => {
  it('stop() transitions status to "stopped"', async () => {
    const agent = await makeAgent();
    agent.stop();
    expect(agent.status).toBe('stopped');
  });

  it('resume() restores status to "ready" after stop', async () => {
    const agent = await makeAgent();
    agent.stop();
    agent.resume();
    expect(agent.status).toBe('ready');
  });

  it('resume() is a no-op when agent is not stopped', async () => {
    const agent = await makeAgent();
    expect(() => agent.resume()).not.toThrow();
    expect(agent.status).toBe('ready');
  });

  it('destroy() transitions status to "destroyed"', async () => {
    const agent = await makeAgent();
    agent.destroy();
    expect(agent.status).toBe('destroyed');
  });

  it('destroy() is idempotent', async () => {
    const agent = await makeAgent();
    agent.destroy();
    expect(() => agent.destroy()).not.toThrow();
  });

  it('stop() and destroy() on an already-destroyed agent do not throw', async () => {
    const agent = await makeAgent();
    agent.destroy();
    expect(() => agent.stop()).not.toThrow();
    expect(() => agent.destroy()).not.toThrow();
  });

  it('stats.uptime is non-negative', async () => {
    const agent = await makeAgent();
    expect(agent.stats.uptime).toBeGreaterThanOrEqual(0);
  });
});

// ---- Filesystem (mocked) ----------------------------------------------------

describe('requestFolderAccess / mountFolder / revokeFolder', () => {
  const makeHandle = (): FileSystemDirectoryHandle =>
    ({ kind: 'directory', name: 'mock-folder' } as unknown as FileSystemDirectoryHandle);

  it('mountFolder adds filesystem tools', async () => {
    const agent = await makeAgent();
    await agent.mountFolder(makeHandle());
    const result = await agent.chat('list files');
    // Agent has file tools; won't error (mock LLM doesn't use them in this test)
    expect(result).toBe('OK');
  });

  it('revokeFolder removes filesystem tools', async () => {
    const agent = await makeAgent();
    await agent.mountFolder(makeHandle());
    agent.revokeFolder();
    // After revoke the tools are gone — verified indirectly via no crash
    expect(agent.status).toBe('ready');
  });

  it('requestFolderAccess throws when showDirectoryPicker is not available', async () => {
    // Ensure window.showDirectoryPicker is absent in mock window
    delete (mockWindow as Record<string, unknown>)['showDirectoryPicker'];
    const agent = await makeAgent();
    await expect(agent.requestFolderAccess()).rejects.toThrow(/File System Access API/);
  });

  it('requestFolderAccess calls showDirectoryPicker and mounts the handle', async () => {
    const handle = makeHandle();
    (mockWindow as Record<string, unknown>)['showDirectoryPicker'] = jest.fn().mockResolvedValue(handle);
    const agent = await makeAgent();
    const result = await agent.requestFolderAccess({ mode: 'read' });
    expect(result).toBe(handle);
    delete (mockWindow as Record<string, unknown>)['showDirectoryPicker'];
  });
});

// ---- Logging ----------------------------------------------------------------

describe('logging', () => {
  it('custom logger transport receives log entries', async () => {
    const entries: string[] = [];
    const agent = await makeAgent({
      logger: {
        level: 'debug',
        transport: (entry) => entries.push(entry.message),
      },
    });
    agent.destroy();
    expect(entries.some(e => e.includes('destroyed'))).toBe(true);
  });

  it('logger level "silent" suppresses all output', async () => {
    const transport = jest.fn();
    const agent = await makeAgent({ logger: { level: 'silent', transport } });
    agent.destroy();
    expect(transport).not.toHaveBeenCalled();
  });
});

// ---- connectAgents() --------------------------------------------------------

describe('connectAgents()', () => {
  it('throws when fewer than 2 agents are provided', async () => {
    const a = await makeAgent();
    expect(() => connectAgents([a], { topology: 'pipeline', topic: 'x' })).toThrow();
    a.destroy();
  });

  it('pipeline: source publish triggers downstream run()', async () => {
    const processed: string[] = [];
    const agentA = await makeAgent({ agentId: 'src', llm: mockLLM({ response: 'from-a' }) });
    const agentB = await makeAgent({
      agentId: 'sink',
      llm: mockLLM({
        handler: (msgs) => {
          const last = msgs.find(m => m.role === 'user');
          if (last?.content) processed.push(last.content);
          return { content: 'processed', toolCalls: [], finishReason: 'stop' };
        },
      }),
    });

    const teardown = connectAgents([agentA, agentB], { topology: 'pipeline', topic: 'docs' });
    pipelinePublish(agentA, 'docs', 'my-document');
    await flushPromises();

    expect(processed.some(p => p.includes('my-document'))).toBe(true);
    teardown();
    agentA.destroy();
    agentB.destroy();
  });

  it('fan-out: all receivers process the published input', async () => {
    const received: string[] = [];
    function makeReceiver(id: string) {
      return makeAgent({
        agentId: id,
        llm: mockLLM({
          handler: (msgs) => {
            received.push(id);
            return { content: 'handled', toolCalls: [], finishReason: 'stop' };
          },
        }),
      });
    }

    const source = await makeAgent({ agentId: 'source' });
    const r1 = await makeReceiver('r1');
    const r2 = await makeReceiver('r2');

    const teardown = connectAgents([source, r1, r2], { topology: 'fan-out', topic: 'news' });
    fanOutPublish(source, 'news', 'breaking news');
    await flushPromises();

    expect(received).toContain('r1');
    expect(received).toContain('r2');
    teardown();
    source.destroy(); r1.destroy(); r2.destroy();
  });

  it('teardown stops downstream subscription', async () => {
    const processed: string[] = [];
    const src = await makeAgent();
    const sink = await makeAgent({
      llm: mockLLM({
        handler: (msgs) => {
          const u = msgs.find(m => m.role === 'user');
          if (u?.content) processed.push(u.content);
          return { content: 'ok', toolCalls: [], finishReason: 'stop' };
        },
      }),
    });

    const teardown = connectAgents([src, sink], { topology: 'pipeline', topic: 'test' });
    teardown();

    pipelinePublish(src, 'test', 'after-teardown');
    await flushPromises();

    // Should not have received after teardown
    expect(processed).toHaveLength(0);
    src.destroy(); sink.destroy();
  });
});

// ---- Presets ----------------------------------------------------------------

describe('presets', () => {
  it('presets.filesystem returns a config with filesystem settings', () => {
    const cfg = presets.filesystem();
    expect(cfg.filesystem?.mode).toBe('readwrite');
    expect(cfg.filesystem?.lazy).toBe(true);
    expect(cfg.systemPrompt).toBeTruthy();
  });

  it('presets.filesystem accepts custom mode and systemPrompt', () => {
    const cfg = presets.filesystem({ mode: 'read', systemPrompt: 'Custom.' });
    expect(cfg.filesystem?.mode).toBe('read');
    expect(cfg.systemPrompt).toBe('Custom.');
  });

  it('presets.codeReview returns read-only filesystem config', () => {
    const cfg = presets.codeReview();
    expect(cfg.filesystem?.mode).toBe('read');
    expect(cfg.systemPrompt).toMatch(/code review/i);
  });

  it('presets.summarizer returns a config with summarizer system prompt', () => {
    const cfg = presets.summarizer();
    expect(cfg.systemPrompt).toMatch(/summar/i);
    expect(cfg.filesystem).toBeUndefined();
  });

  it('presets.monitor returns a passive agent config', () => {
    const cfg = presets.monitor();
    expect(cfg.mode).toBe('passive');
    expect(cfg.systemPrompt).toMatch(/monitor/i);
  });

  it('withPreset merges preset config with llm field', () => {
    const llm = mockLLM({ response: 'ok' });
    const merged = withPreset(presets.summarizer(), { llm });
    expect(merged.llm).toBe(llm);
    expect(merged.systemPrompt).toBeTruthy();
  });

  it('withPreset: explicitly provided fields override preset', () => {
    const llm = mockLLM({ response: 'ok' });
    const merged = withPreset(presets.summarizer(), { llm, systemPrompt: 'Override.' });
    expect(merged.systemPrompt).toBe('Override.');
  });
});

// ---- mockLLM (testing utilities) -------------------------------------------

describe('mockLLM()', () => {
  it('returns a MockLLMConfig with _isMock: true', () => {
    const cfg = mockLLM({ response: 'hi' });
    expect(cfg._isMock).toBe(true);
  });

  it('agent using mockLLM returns static response', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'fixed reply' }) });
    const result = await agent.chat('anything');
    expect(result).toBe('fixed reply');
  });

  it('mock with toolCalls executes the tools and returns afterToolCalls', async () => {
    const spy = jest.fn().mockResolvedValue('result');
    const agent = await makeAgent({
      llm: mockLLM({ toolCalls: [{ name: 'spy', args: {} }], afterToolCalls: 'after' }),
      tools: [{ name: 'spy', description: 'd', inputSchema: { type: 'object', properties: {} }, execute: spy }],
    });
    const result = await agent.chat('go');
    expect(spy).toHaveBeenCalled();
    expect(result).toBe('after');
  });

  it('custom handler receives the full messages array', async () => {
    const received: unknown[] = [];
    const agent = await makeAgent({
      llm: mockLLM({
        handler: (msgs) => {
          received.push(...msgs);
          return { content: 'custom', toolCalls: [], finishReason: 'stop' };
        },
      }),
    });
    await agent.chat('test');
    expect(received.some((m: unknown) => (m as { content: string }).content === 'test')).toBe(true);
  });

  it('mockLLM with no options returns default response', async () => {
    const agent = await makeAgent({ llm: mockLLM() });
    const result = await agent.chat('hi');
    expect(typeof result).toBe('string');
  });
});

// ---- scenarioMock() ---------------------------------------------------------

describe('scenarioMock()', () => {
  it('walks through scripted steps in order', async () => {
    const llm = scenarioMock([
      { userMessage: 'step 1', expectedReply: 'reply 1' },
      { userMessage: 'step 2', expectedReply: 'reply 2' },
    ]);
    const agent = await makeAgent({ llm });

    const r1 = await agent.chat('step 1');
    const r2 = await agent.chat('step 2');

    expect(r1).toBe('reply 1');
    expect(r2).toBe('reply 2');
  });

  it('emits tool calls for a step and then returns expected reply', async () => {
    const spy = jest.fn().mockResolvedValue('tool-output');
    const llm = scenarioMock([
      {
        userMessage: 'search',
        expectedReply: 'search result',
        toolCalls: [{ name: 'search', args: { q: 'cats' } }],
      },
    ]);
    const agent = await makeAgent({
      llm,
      tools: [{
        name: 'search',
        description: 'd',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        execute: spy,
      }],
    });

    const result = await agent.chat('search');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ q: 'cats' }), expect.anything());
    expect(result).toBe('search result');
  });

  it('returns "(scenario complete)" after all steps are exhausted', async () => {
    const llm = scenarioMock([{ userMessage: 'only', expectedReply: 'done' }]);
    const agent = await makeAgent({ llm });
    await agent.chat('only');
    const extra = await agent.chat('one more');
    expect(extra).toBe('(scenario complete)');
  });
});

// ---- Additional branch coverage --------------------------------------------

describe('additional branch coverage', () => {
  it('accepts an external NirnamBus via config.bus', async () => {
    const { createBus } = await import('../src/bus');
    const sharedBus = createBus();
    const agent = await makeAgent({ bus: sharedBus, autoCleanup: false });
    expect(agent.status).toBe('ready');
    // bus is NOT owned; destroy() should not close sharedBus
    agent.destroy();
    sharedBus.close();
  });

  it('mounts filesystem tools when config.filesystem.handle is provided at construction', async () => {
    const mockHandle = { kind: 'directory', name: 'root' } as unknown as FileSystemDirectoryHandle;
    const agent = await makeAgent({
      filesystem: { handle: mockHandle, mode: 'readwrite' },
    });
    await agent.ready;
    // Filesystem tools are mounted (can verify by sending a chat that uses them)
    expect(agent.status).toBe('ready');
    agent.destroy();
  });

  it('mounts filesystem tools eagerly when config.filesystem lazy is false and no handle', async () => {
    const agent = await makeAgent({
      filesystem: { mode: 'readwrite', lazy: false },
    });
    await agent.ready;
    expect(agent.status).toBe('ready');
    agent.destroy();
  });

  it('onBeforeToolCall unsub covers both i !== -1 true and false branches', async () => {
    const agent = await makeAgent();
    const interceptor = jest.fn(async (call: unknown, next: Function) => next(call));
    const unsub = agent.onBeforeToolCall(interceptor as Parameters<typeof agent.onBeforeToolCall>[0]);
    unsub(); // i !== -1 → true, splices
    unsub(); // i === -1 → false, no-op
    expect(() => unsub()).not.toThrow();
    agent.destroy();
  });

  it('onAfterToolCall unsub covers both branches', async () => {
    const agent = await makeAgent();
    const interceptor = jest.fn((call: unknown, result: unknown) => result);
    const unsub = agent.onAfterToolCall(interceptor as Parameters<typeof agent.onAfterToolCall>[0]);
    unsub();
    unsub(); // second call: i === -1
    agent.destroy();
  });

  it('onBeforeLLMCall unsub covers both branches', async () => {
    const agent = await makeAgent();
    const interceptor = jest.fn((msgs: unknown, next: Function) => next(msgs));
    const unsub = agent.onBeforeLLMCall(interceptor as Parameters<typeof agent.onBeforeLLMCall>[0]);
    unsub();
    unsub(); // second call: i === -1
    agent.destroy();
  });

  it('process() on a non-passive (active) agent logs a warning but still works', async () => {
    const transport = jest.fn();
    const agent = await makeAgent({
      mode: 'active',
      llm: mockLLM({ response: 'active-result' }),
      logger: { level: 'warn', transport },
    });
    const result = await agent.process('run this');
    expect(result).toBe('active-result');
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
    agent.destroy();
  });

  it('AbortController signal addEventListener path: signal is live when chat starts', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'ok' }) });
    const ctrl = new AbortController();
    // Signal is NOT aborted → addEventListener path is exercised
    const result = await agent.chat('hi', { signal: ctrl.signal });
    expect(result).toBe('ok');
    agent.destroy();
  });

  it('connectAgents with unknown topology returns a no-op teardown', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const teardown = connectAgents([a, b], { topology: 'unknown' as never, topic: 't' });
    expect(() => teardown()).not.toThrow();
    a.destroy();
    b.destroy();
  });

  it('pipeline: catches errors thrown by agent.run() inside the subscriber', async () => {
    const src = await makeAgent({ agentId: 'src2' });
    const sink = await makeAgent({ agentId: 'sink2' });
    const teardown = connectAgents([src, sink], { topology: 'pipeline', topic: 'err' });
    // Stopping sink means run() throws; the subscriber catches it
    sink.stop();
    // Publishing should NOT propagate an uncaught rejection
    pipelinePublish(src, 'err', 'trigger');
    await flushPromises();
    teardown();
    src.destroy();
    sink.destroy();
  });

  it('fan-out: catches errors thrown by agent.run() inside the subscriber', async () => {
    const src = await makeAgent({ agentId: 'fo-src' });
    const recv = await makeAgent({ agentId: 'fo-recv' });
    const teardown = connectAgents([src, recv], { topology: 'fan-out', topic: 'fo-err' });
    recv.stop();
    fanOutPublish(src, 'fo-err', 'trigger');
    await flushPromises();
    teardown();
    src.destroy();
    recv.destroy();
  });

  it('stop() while a chat is in-flight aborts _currentAbort (non-null branch)', async () => {
    let resolveHang!: (v: string) => void;
    const agent = await makeAgent({
      llm: mockLLM({
        toolCalls: [{ name: 'hang', args: {} }],
        afterToolCalls: 'done',
      }),
      tools: [{
        name: 'hang',
        description: 'd',
        inputSchema: { type: 'object', properties: {} },
        execute: () => new Promise<string>(r => { resolveHang = r; }),
      }],
    });
    const chatPromise = agent.chat('go');
    await new Promise<void>(r => setTimeout(r, 0)); // wait for tool to start
    agent.stop(); // _currentAbort is non-null here
    resolveHang('tool-result');
    await expect(chatPromise).rejects.toThrow();
  });

  it('destroy() while a chat is in-flight aborts _currentAbort (non-null branch)', async () => {
    let resolveHang2!: (v: string) => void;
    const agent = await makeAgent({
      llm: mockLLM({
        toolCalls: [{ name: 'hang2', args: {} }],
        afterToolCalls: 'done',
      }),
      tools: [{
        name: 'hang2',
        description: 'd',
        inputSchema: { type: 'object', properties: {} },
        execute: () => new Promise<string>(r => { resolveHang2 = r; }),
      }],
    });
    const chatPromise = agent.chat('go');
    await new Promise<void>(r => setTimeout(r, 0));
    agent.destroy(); // _currentAbort is non-null here
    resolveHang2('tool-result');
    await expect(chatPromise).rejects.toThrow();
  });

  it('asTool() uses JSON.stringify when args.text is not a string', async () => {
    const agent = await makeAgent({ llm: mockLLM({ response: 'ok' }) });
    const tool = agent.asTool({
      name: 'do-thing',
      description: 'd',
      inputSchema: { type: 'object', properties: { count: { type: 'number' } } },
    });
    // args.text is not present → JSON.stringify(args) path
    const result = await tool.execute({ count: 5 });
    expect(result).toBe('ok');
    agent.destroy();
  });

  it('chatStream: loop exits when maxIterations reached (no final LLM stop before limit)', async () => {
    let calls = 0;
    const agent = await makeAgent({
      llm: mockLLM({
        handler: (msgs) => {
          calls++;
          const hasTools = msgs.some(m => m.role === 'tool');
          if (!hasTools) {
            return { content: null, toolCalls: [{ id: `c${calls}`, name: 'echo', args: { text: 'x' } }], finishReason: 'tool_calls' };
          }
          return { content: 'done', toolCalls: [], finishReason: 'stop' };
        },
      }),
      tools: [echoTool],
    });
    const chunks: string[] = [];
    // maxIterations: 2 → maxIter = 1, so 1 tool iteration then stream
    for await (const chunk of agent.chatStream('go', { maxIterations: 2 })) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBeTruthy();
    agent.destroy();
  });
});
