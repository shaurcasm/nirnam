/**
 * Tests for the page-scoped agent feature (L2) — scope: 'page' option on
 * createAgent() and the AgentProxy / createAgentProxy cross-tab factory.
 *
 * Uses fake-indexeddb for the IndexedDB history-store tests.
 * Uses the same MockSharedWorker + MockBroadcastChannel infrastructure as
 * agents.test.ts so request/handle routing works within the test process.
 */

jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createAgent, NirnamAgent } from '../src/agents/agent';
import { AgentProxy, createAgentProxy } from '../src/agents/agent-proxy';
import { resetHistoryDb, saveAgentHistory, loadAgentHistory, deleteAgentHistory } from '../src/agents/history-store';
import { mockLLM } from '../src/agents-testing';
import { createBus } from '../src/bus';
import { resetWorkerState, resetBroadcastChannels } from './setup';

// ---- Window mock for autoCleanup -------------------------------------------

(global as unknown as Record<string, unknown>).window = {
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
};

// ---- IDB helpers ------------------------------------------------------------

/**
 * Drain N setImmediate phases from the event loop.
 * fake-indexeddb schedules IDB callbacks via setImmediate, so
 * microtask-based flushes are insufficient.
 */
const drainIdb = async (cycles = 12) => {
  for (let i = 0; i < cycles; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
};

const flushPromises = () => new Promise<void>(r => setTimeout(r, 0));

// ---- Setup / teardown -------------------------------------------------------

beforeEach(() => {
  (global as unknown as Record<string, unknown>).indexedDB = new IDBFactory();
  resetHistoryDb();
  resetWorkerState();
  resetBroadcastChannels();
  jest.clearAllMocks();
});

// ---- Helpers ----------------------------------------------------------------

/** Create a page-scoped host agent with its own bus. */
async function makePageAgent(overrides: Partial<Parameters<typeof createAgent>[0]> = {}) {
  const bus = createBus();
  const agent = createAgent({
    agentId: 'test-page-agent',
    scope: 'page',
    llm: mockLLM({ response: 'page-reply' }),
    bus,
    autoCleanup: false,
    ...overrides,
  });
  await agent.ready;
  return { agent, bus };
}

/** Create a second bus (simulates another tab) and an AgentProxy on top of it. */
function makeProxy(agentId = 'test-page-agent', timeout = 5_000) {
  const proxyBus = createBus();
  const proxy = createAgentProxy(agentId, proxyBus, { timeout });
  return { proxy, proxyBus };
}

// ===========================================================================
// AgentProxy class
// ===========================================================================

describe('AgentProxy', () => {
  it('is constructible via new AgentProxy()', async () => {
    const { bus } = await makePageAgent();
    const proxy = new AgentProxy('test-page-agent', bus, { timeout: 1_000 });
    expect(proxy).toBeInstanceOf(AgentProxy);
    expect(proxy.agentId).toBe('test-page-agent');
  });
});

// ===========================================================================
// createAgentProxy
// ===========================================================================

describe('createAgentProxy', () => {
  it('returns an AgentProxy with the given agentId', async () => {
    const { bus } = await makePageAgent();
    const proxy = createAgentProxy('test-page-agent', bus);
    expect(proxy).toBeInstanceOf(AgentProxy);
    expect(proxy.agentId).toBe('test-page-agent');
  });

  it('uses the timeout from options', async () => {
    const { bus } = await makePageAgent();
    const proxy = createAgentProxy('test-page-agent', bus, { timeout: 99_000 });
    // Indirectly test: the proxy is created without throwing.
    expect(proxy.agentId).toBe('test-page-agent');
  });
});

// ===========================================================================
// page-scoped agent initialisation
// ===========================================================================

describe('createAgent({ scope: "page" })', () => {
  it('resolves ready with status "ready"', async () => {
    const { agent } = await makePageAgent();
    expect(agent.status).toBe('ready');
  });

  it('is still an instance of NirnamAgent', async () => {
    const { agent } = await makePageAgent();
    expect(agent).toBeInstanceOf(NirnamAgent);
  });

  it('includes scope: "page" in the bus registration metadata', async () => {
    const { bus } = await makePageAgent();
    const agents = await bus.discoverAgents();
    const reg = agents.find(a => a.agentId === 'test-page-agent');
    expect(reg?.metadata?.scope).toBe('page');
  });

  it('scope: "tab" (default) does not set metadata.scope', async () => {
    const bus = createBus();
    const agent = createAgent({
      agentId: 'tab-agent',
      llm: mockLLM({ response: 'ok' }),
      bus,
      autoCleanup: false,
    });
    await agent.ready;
    const agents = await bus.discoverAgents();
    const reg = agents.find(a => a.agentId === 'tab-agent');
    expect(reg?.metadata?.scope).toBeUndefined();
  });
});

// ===========================================================================
// Cross-tab routing — proxy → host agent
// ===========================================================================

describe('AgentProxy.chat() → host agent', () => {
  it('returns the agent response via bus request/handle', async () => {
    await makePageAgent({ llm: mockLLM({ response: 'Hello proxy!' }) });
    const { proxy } = makeProxy();
    const result = await proxy.chat('Hi');
    expect(result).toBe('Hello proxy!');
  });

  it('forwards maxIterations to the host agent', async () => {
    // Use scenarioMock to verify the LLM is called (proxy at least reaches the agent).
    await makePageAgent({ llm: mockLLM({ response: 'iter-reply' }) });
    const { proxy } = makeProxy();
    const result = await proxy.chat('test', { maxIterations: 3 });
    expect(result).toBe('iter-reply');
  });

  it('uses a per-call timeout override', async () => {
    await makePageAgent({ llm: mockLLM({ response: 'timeout-ok' }) });
    const { proxy } = makeProxy('test-page-agent', 1_000);
    const result = await proxy.chat('hi', { timeout: 5_000 });
    expect(result).toBe('timeout-ok');
  });
});

describe('AgentProxy.run() → host agent', () => {
  it('returns the agent run response via bus request/handle', async () => {
    await makePageAgent({ llm: mockLLM({ response: 'run-reply' }) });
    const { proxy } = makeProxy();
    const result = await proxy.run('Do task');
    expect(result).toBe('run-reply');
  });
});

describe('AgentProxy.chatStream() → host agent', () => {
  it('streams chunks from the host agent', async () => {
    await makePageAgent({ llm: mockLLM({ response: 'streamed' }) });
    const { proxy } = makeProxy();
    const chunks: string[] = [];
    for await (const chunk of proxy.chatStream('stream me')) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('streamed');
  });
});

// ===========================================================================
// Concurrency serialisation
// ===========================================================================

describe('page-scope request queue', () => {
  it('serialises concurrent proxy chat() calls to avoid history corruption', async () => {
    const responses = ['first', 'second'];
    let callIdx = 0;
    await makePageAgent({
      llm: mockLLM({ handler: () => ({ content: responses[callIdx++] ?? 'extra', toolCalls: [], finishReason: 'stop' }) }),
    });
    const { proxy } = makeProxy();

    // Fire both at the same time — they should be serialised by the queue.
    const [r1, r2] = await Promise.all([proxy.chat('A'), proxy.chat('B')]);
    expect([r1, r2]).toEqual(expect.arrayContaining(['first', 'second']));
  });
});

// ===========================================================================
// IndexedDB history persistence
// ===========================================================================

describe('history persistence after chat()', () => {
  it('saves history to IndexedDB after chat() completes', async () => {
    await makePageAgent({ llm: mockLLM({ response: 'stored' }) });
    const { proxy } = makeProxy();
    await proxy.chat('Remember this');
    await drainIdb();

    const stored = await loadAgentHistory('test-page-agent');
    expect(stored).not.toBeNull();
    expect(stored!.some(m => m.role === 'user' && m.content === 'Remember this')).toBe(true);
    expect(stored!.some(m => m.role === 'assistant' && m.content === 'stored')).toBe(true);
  });

  it('accumulates history across multiple chat() calls', async () => {
    await makePageAgent({ llm: mockLLM({ response: 'ok' }) });
    const { proxy } = makeProxy();
    await proxy.chat('first');
    await proxy.chat('second');
    await drainIdb();

    const stored = await loadAgentHistory('test-page-agent');
    const userMessages = stored?.filter(m => m.role === 'user').map(m => m.content);
    expect(userMessages).toContain('first');
    expect(userMessages).toContain('second');
  });
});

describe('history persistence after chatStream()', () => {
  it('saves history to IndexedDB after chatStream() finishes', async () => {
    await makePageAgent({ llm: mockLLM({ response: 'streamed-save' }) });
    const { proxy } = makeProxy();

    const chunks: string[] = [];
    for await (const chunk of proxy.chatStream('Stream and save')) {
      chunks.push(chunk);
    }
    await drainIdb();

    const stored = await loadAgentHistory('test-page-agent');
    expect(stored!.some(m => m.role === 'user' && m.content === 'Stream and save')).toBe(true);
    expect(stored!.some(m => m.role === 'assistant' && m.content === 'streamed-save')).toBe(true);
  });
});

// ===========================================================================
// History restore on page reload (agent recreation)
// ===========================================================================

describe('history restore from IndexedDB', () => {
  it('restores saved history when a page-scoped agent is re-created with the same agentId', async () => {
    // Seed IDB directly as if a previous session had saved history.
    await saveAgentHistory('test-page-agent', [
      { role: 'user', content: 'previous message' },
      { role: 'assistant', content: 'previous reply' },
    ]);
    await drainIdb();
    await flushPromises();

    const { agent } = await makePageAgent();
    const history = agent.history;
    expect(history.some(m => m.role === 'user' && m.content === 'previous message')).toBe(true);
    expect(history.some(m => m.role === 'assistant' && m.content === 'previous reply')).toBe(true);
  });

  it('starts with empty history when no prior session data exists', async () => {
    const { agent } = await makePageAgent();
    expect(agent.history).toHaveLength(0);
  });

  it('scope: "tab" agent does NOT restore from IndexedDB', async () => {
    await saveAgentHistory('tab-only-agent', [
      { role: 'user', content: 'tab message' },
    ]);
    await drainIdb();

    const bus = createBus();
    const agent = createAgent({
      agentId: 'tab-only-agent',
      scope: 'tab',
      llm: mockLLM({ response: 'ok' }),
      bus,
      autoCleanup: false,
    });
    await agent.ready;
    expect(agent.history).toHaveLength(0);
  });
});

// ===========================================================================
// run() persistence — retainHistory: true
// ===========================================================================

describe('run() with retainHistory: true', () => {
  it('persists history after run() when retainHistory is true', async () => {
    await makePageAgent({
      llm: mockLLM({ response: 'run-stored' }),
      retainHistory: true,
    });
    const { proxy } = makeProxy();
    await proxy.run('Do a task');
    await drainIdb();

    const stored = await loadAgentHistory('test-page-agent');
    expect(stored!.some(m => m.role === 'user' && m.content === 'Do a task')).toBe(true);
  });

  it('does NOT persist extra history after run() when retainHistory is false (default)', async () => {
    await makePageAgent({ llm: mockLLM({ response: 'run-no-store' }) });
    const { proxy } = makeProxy();
    await proxy.run('Ephemeral task');
    await drainIdb();

    // Nothing persisted because the internal history was restored to pre-run state.
    const stored = await loadAgentHistory('test-page-agent');
    const hasRunMessage = stored?.some(m => m.content === 'Ephemeral task') ?? false;
    expect(hasRunMessage).toBe(false);
  });
});

// ===========================================================================
// history-store module — unit tests
// ===========================================================================

describe('saveAgentHistory / loadAgentHistory', () => {
  it('returns null when no history exists for the given agentId', async () => {
    const result = await loadAgentHistory('non-existent');
    expect(result).toBeNull();
  });

  it('round-trips a history array', async () => {
    const history = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'world' },
    ];
    await saveAgentHistory('my-agent', history);
    await drainIdb();
    const loaded = await loadAgentHistory('my-agent');
    expect(loaded).toEqual(history);
  });

  it('overwrites prior history with a fresh save', async () => {
    await saveAgentHistory('my-agent', [{ role: 'user', content: 'old' }]);
    await drainIdb();
    await saveAgentHistory('my-agent', [{ role: 'user', content: 'new' }]);
    await drainIdb();
    const loaded = await loadAgentHistory('my-agent');
    expect(loaded).toHaveLength(1);
    expect(loaded![0].content).toBe('new');
  });
});

describe('deleteAgentHistory', () => {
  it('removes the stored history for the given agentId', async () => {
    await saveAgentHistory('del-agent', [{ role: 'user', content: 'bye' }]);
    await drainIdb();
    await deleteAgentHistory('del-agent');
    await drainIdb();
    const loaded = await loadAgentHistory('del-agent');
    expect(loaded).toBeNull();
  });
});
