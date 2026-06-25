/**
 * Nirnam — Cross-tab Agent Example
 *
 * Demonstrates scope: 'page' agents and AgentProxy (L2).
 *
 * HOW IT WORKS:
 *   The app auto-discovers whether a page-scoped 'shared-assistant' agent is
 *   already running in another tab (via bus.discoverAgents()).
 *
 *   HOST TAB:  Creates the real NirnamAgent (runs the LLM).
 *              Registers bus handlers so other tabs can reach it.
 *              Persists conversation history to IndexedDB between reloads.
 *
 *   CLIENT TABS:  Use createAgentProxy() to forward chat() / chatStream()
 *                 calls to the host tab over the Layer 3 SharedWorker.
 *
 * LLM:
 *   Defaults to a local mock that echoes messages — open the LLM panel to
 *   switch to a real Ollama or OpenAI-compatible endpoint.
 */

import {
  useState, useEffect, useRef, useCallback, useMemo,
  type FormEvent, type ReactNode, type RefObject, type CSSProperties,
} from 'react';
import { createBus } from '@palinc/nirnam';
import {
  createAgent, createAgentProxy,
  type NirnamAgent, type AgentStatus, type LLMConfig,
} from '@palinc/nirnam/agents';
import { mockLLM } from '@palinc/nirnam/agents/testing';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID = 'shared-assistant';
const TAB_ID = Math.random().toString(36).slice(2, 6).toUpperCase();

// The bus is module-level so all re-renders share one connection.
// nirnamPlugin() (in vite.config.ts) injects __NIRNAM_STATIC_WORKER_URL__ at
// build time, making this a Layer 3 (static URL) bus — required for cross-tab
// request routing.
const bus = createBus();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clr = {
  blue: '#1d4ed8', blueLight: '#eff6ff', blueBorder: '#bfdbfe',
  green: '#16a34a', greenLight: '#f0fdf4', greenBorder: '#86efac',
  amber: '#b45309', amberLight: '#fffbeb', amberBorder: '#fde68a',
  gray: '#6b7280', grayLight: '#f9fafb', grayBorder: '#e5e7eb',
  red: '#dc2626', redLight: '#fef2f2', redBorder: '#fecaca',
};

function Badge({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 600,
      padding: '2px 8px', borderRadius: 12,
      background: color === 'green' ? clr.greenLight : color === 'blue' ? clr.blueLight : clr.amberLight,
      color: color === 'green' ? clr.green : color === 'blue' ? clr.blue : clr.amber,
      border: `1px solid ${color === 'green' ? clr.greenBorder : color === 'blue' ? clr.blueBorder : clr.amberBorder}`,
    }}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppMode = 'detecting' | 'host' | 'client';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  fromTab?: string;
  restored?: boolean;
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function App() {
  // sessionStorage persists across refreshes (but not new tabs), so the host
  // tab stays host after a reload without re-running discoverAgents().
  const [mode, setMode] = useState<AppMode>(() =>
    sessionStorage.getItem('nirnam-tab-role') === 'host' ? 'host' : 'detecting'
  );
  const [llmConfig, setLlmConfig] = useState<LLMConfig>(
    mockLLM({
      handler: (msgs) => {
        const last = msgs.findLast(m => m.role === 'user')?.content ?? '';
        return {
          content: `[mock] Echo from shared-assistant: "${last}"`,
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    }),
  );
  const [showLlmPanel, setShowLlmPanel] = useState(false);
  const [llmUrl, setLlmUrl] = useState('http://localhost:11434/v1');
  const [llmModel, setLlmModel] = useState('llama3.2');

  const activateRealLlm = () => {
    setLlmConfig({ url: llmUrl, model: llmModel, provider: 'openai-compat' });
    setShowLlmPanel(false);
  };

  const activateMock = () => {
    setLlmConfig(mockLLM({
      handler: (msgs) => {
        const last = msgs.findLast(m => m.role === 'user')?.content ?? '';
        return { content: `[mock] Echo: "${last}"`, toolCalls: [], finishReason: 'stop' };
      },
    }));
    setShowLlmPanel(false);
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 680, margin: '40px auto', padding: '0 20px' }}>

      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>Nirnam — Cross-tab Agent</h1>
        <p style={{ fontSize: 12, color: clr.gray, margin: '0 0 8px' }}>
          This tab: <strong>{TAB_ID}</strong>
          {' · '}
          <button
            onClick={() => window.open(window.location.href, '_blank')}
            style={{ fontSize: 12, color: clr.blue, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
          >
            Open client tab →
          </button>
        </p>
        <div style={{ fontSize: 11, color: clr.gray, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setShowLlmPanel(p => !p)}
            style={{ fontSize: 11, color: clr.gray, background: 'none', border: '1px solid ' + clr.grayBorder, borderRadius: 4, cursor: 'pointer', padding: '2px 8px' }}
          >
            {showLlmPanel ? 'Close LLM config ▲' : 'LLM config ▼'}
          </button>
          {'_isMock' in llmConfig
            ? <Badge color="amber">Mock LLM (echo)</Badge>
            : <Badge color="blue">{'url' in llmConfig ? llmConfig.url : ''}</Badge>
          }
        </div>
      </div>

      {/* LLM panel */}
      {showLlmPanel && (
        <div style={{ border: '1px solid ' + clr.grayBorder, borderRadius: 8, padding: '12px 16px', marginBottom: 20, background: clr.grayLight, fontSize: 13 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600 }}>LLM Configuration</p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input
              value={llmUrl}
              onChange={e => setLlmUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              style={{ flex: 2, padding: '4px 8px', fontSize: 12, border: '1px solid ' + clr.grayBorder, borderRadius: 4 }}
            />
            <input
              value={llmModel}
              onChange={e => setLlmModel(e.target.value)}
              placeholder="llama3.2"
              style={{ flex: 1, padding: '4px 8px', fontSize: 12, border: '1px solid ' + clr.grayBorder, borderRadius: 4 }}
            />
            <button onClick={activateRealLlm} style={{ padding: '4px 12px', fontSize: 12, background: clr.blue, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
              Use real LLM
            </button>
          </div>
          <button onClick={activateMock} style={{ fontSize: 11, color: clr.gray, background: 'none', border: '1px solid ' + clr.grayBorder, borderRadius: 4, cursor: 'pointer', padding: '2px 8px' }}>
            Reset to mock (no backend needed)
          </button>
        </div>
      )}

      {/* Mode views */}
      {mode === 'detecting' && (
        <DetectingView
          onForceHost={() => { sessionStorage.setItem('nirnam-tab-role', 'host'); setMode('host'); }}
          onForceClient={() => setMode('client')}
        />
      )}
      {mode === 'host' && (
        <HostView llm={llmConfig} />
      )}
      {mode === 'client' && (
        <ClientView onNoHost={() => { sessionStorage.removeItem('nirnam-tab-role'); setMode('detecting'); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DetectingView
// ---------------------------------------------------------------------------

function DetectingView({ onForceHost, onForceClient }: {
  onForceHost: () => void;
  onForceClient: () => void;
}) {
  const [checking, setChecking] = useState(true);
  const [found, setFound] = useState(false);

  useEffect(() => {
    (async () => {
      const agents = await bus.discoverAgents();
      const exists = agents.some(a => a.agentId === AGENT_ID && a.metadata?.scope === 'page');
      setFound(exists);
      setChecking(false);
      if (exists) onForceClient();
    })();
  }, [onForceClient]);

  if (checking) return <p style={{ color: clr.gray, fontSize: 13 }}>Looking for an existing agent host…</p>;

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <Card title="Start as Host" color="green">
        <p style={{ fontSize: 13, color: clr.gray, margin: '0 0 12px' }}>
          This tab will run the real NirnamAgent (LLM + tools).
          Other tabs connect via <code>AgentProxy</code>.
        </p>
        <button onClick={onForceHost} style={btnStyle(clr.green)}>
          Start hosting
        </button>
      </Card>
      <Card title="Connect as Client" color="blue">
        <p style={{ fontSize: 13, color: clr.gray, margin: '0 0 12px' }}>
          Requires a host tab. Use the button above to start one,
          then open a new tab and click here.
        </p>
        <button onClick={onForceClient} style={btnStyle(clr.blue)}>
          Connect via proxy
        </button>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HostView
// ---------------------------------------------------------------------------

function HostView({ llm }: { llm: LLMConfig }) {
  const agentRef = useRef<NirnamAgent | null>(null);
  const [status, setStatus] = useState<AgentStatus>('initializing');
  // All messages (local + proxy) arrive via agent.onMessage — no manual push needed.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false); // local-chat in-flight indicator
  const [restoredCount, setRestoredCount] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Reset display state so messages from the old agent don't linger while
    // the new agent initialises. IDB history will repopulate via agent.ready.
    setMessages([]);
    setRestoredCount(0);
    setBusy(false);

    const agent = createAgent({
      agentId: AGENT_ID,
      scope: 'page',
      llm,
      bus,
      autoCleanup: true,
    });
    agentRef.current = agent;

    agent.onStatusChange(s => {
      setStatus(s);
      if (s === 'ready') setBusy(false);
    });

    // onMessage fires for EVERY user/assistant message — including those that
    // arrive via AgentProxy calls from other tabs. This gives the host a live
    // "server log" of all conversations going through the agent.
    agent.onMessage(msg => {
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev; // StrictMode guard
        return [...prev, { id: msg.id, role: msg.role, text: msg.content }];
      });
    });

    agent.ready.then(() => {
      const hist = agent.history;
      if (hist.length > 0) {
        setRestoredCount(hist.length);
        setMessages(hist.map(m => ({
          id: m.id,
          role: m.role,
          text: m.content,
          restored: true,
        })));
      }
    });

    return () => { agent.destroy(); };
  }, [llm]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !agentRef.current) return;
    setInput('');
    setBusy(true);
    // Drain the stream — user + assistant messages arrive via onMessage automatically.
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of agentRef.current.chatStream(text)) { /* streaming */ }
    } finally {
      setBusy(false);
    }
  }, [input, busy]);

  const statusColor = status === 'ready' ? 'green' : status === 'busy' ? 'blue' : 'amber';

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Badge color={statusColor}>{status}</Badge>
        <Badge color="green">Host · {AGENT_ID}</Badge>
        {restoredCount > 0 && (
          <Badge color="amber">{restoredCount} msgs restored from IDB</Badge>
        )}
      </div>

      <InfoBox color="green">
        This tab hosts the real agent. All conversations — including those forwarded
        from other tabs via <code>AgentProxy</code> — appear below.
        History is saved to <strong>IndexedDB</strong>: reload this tab to see it restored.
      </InfoBox>

      <MessageList messages={messages} bottomRef={bottomRef} busy={busy && status === 'busy'} />

      <form onSubmit={sendMessage} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Chat directly on the host tab…"
          disabled={busy || status !== 'ready'}
          style={{ flex: 1, padding: '8px 12px', fontSize: 13, border: '1px solid ' + clr.grayBorder, borderRadius: 6 }}
        />
        <button type="submit" disabled={busy || status !== 'ready'} style={btnStyle(clr.green, true)}>
          {busy ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ClientView
// ---------------------------------------------------------------------------

function ClientView({ onNoHost }: { onNoHost: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Verify the host agent is actually reachable on mount
  useEffect(() => {
    bus.discoverAgents().then(agents => {
      const found = agents.some(a => a.agentId === AGENT_ID && a.metadata?.scope === 'page');
      setConnected(found);
      if (!found) onNoHost();
    });
  }, [onNoHost]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const proxy = useMemo(() => createAgentProxy(AGENT_ID, bus, { timeout: 60_000 }), []);

  const sendMessage = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setStreaming(true);

    const userMsgId = `${Date.now()}-user`;
    setMessages(prev => [...prev, { id: userMsgId, role: 'user', text, fromTab: TAB_ID }]);

    const streamId = `${Date.now()}-stream`;
    setMessages(prev => [...prev, { id: streamId, role: 'assistant', text: '…', fromTab: 'host' }]);

    try {
      let first = true;
      for await (const chunk of proxy.chatStream(text)) {
        setMessages(prev => prev.map(m =>
          m.id === streamId ? { ...m, text: (first ? '' : m.text) + chunk } : m,
        ));
        first = false;
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      setMessages(prev => prev.map(m =>
        m.id === streamId
          ? { ...m, text: `Error: ${msg}`, role: 'system' }
          : m,
      ));
      if (msg.includes('NO_HANDLER') || msg.includes('TIMEOUT')) onNoHost();
    } finally {
      setStreaming(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, streaming, onNoHost]);

  if (connected === null) {
    return <p style={{ color: clr.gray, fontSize: 13 }}>Checking connection…</p>;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Badge color="blue">Client · {TAB_ID}</Badge>
        <Badge color={connected ? 'green' : 'amber'}>
          {connected ? `Proxying → ${AGENT_ID}` : 'Host not found'}
        </Badge>
      </div>

      <InfoBox color="blue">
        This tab uses <code>createAgentProxy()</code> — calls are forwarded over
        the Layer&nbsp;3 SharedWorker to the host tab running the real agent.
      </InfoBox>

      <MessageList messages={messages} bottomRef={bottomRef} busy={streaming} />

      <form onSubmit={sendMessage} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Chat via proxy (routes to the host tab)…"
          disabled={streaming || !connected}
          style={{ flex: 1, padding: '8px 12px', fontSize: 13, border: '1px solid ' + clr.grayBorder, borderRadius: 6 }}
        />
        <button type="submit" disabled={streaming || !connected} style={btnStyle(clr.blue, true)}>
          {streaming ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function MessageList({ messages, bottomRef, busy }: {
  messages: ChatMessage[];
  bottomRef: RefObject<HTMLDivElement | null>;
  busy: boolean;
}) {
  if (messages.length === 0) {
    return (
      <div style={{ border: '1px solid ' + clr.grayBorder, borderRadius: 8, padding: 20, textAlign: 'center', color: clr.gray, fontSize: 13, minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        No messages yet — send one above.
      </div>
    );
  }

  return (
    <div style={{ border: '1px solid ' + clr.grayBorder, borderRadius: 8, padding: '12px 14px', minHeight: 120, maxHeight: 340, overflowY: 'auto' }}>
      {messages.map((m, i) => {
        const isUser = m.role === 'user';
        const isSystem = m.role === 'system';
        const isLast = i === messages.length - 1;
        return (
          <div key={m.id} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: clr.gray, marginBottom: 2 }}>
              {isUser ? `[${m.fromTab ?? TAB_ID}]` : isSystem ? '[system]' : '[agent]'}
              {m.restored ? ' — restored' : ''}
            </div>
            <div style={{
              fontSize: 13,
              padding: '6px 10px',
              borderRadius: 6,
              background: isSystem ? clr.redLight : isUser ? clr.blueLight : clr.grayLight,
              border: `1px solid ${isSystem ? clr.redBorder : isUser ? clr.blueBorder : clr.grayBorder}`,
              color: isSystem ? clr.red : 'inherit',
              whiteSpace: 'pre-wrap',
            }}>
              {m.text}{isLast && busy && m.role === 'assistant' ? '▋' : ''}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function InfoBox({ color, children }: { color: 'green' | 'blue'; children: ReactNode }) {
  const c = color === 'green'
    ? { bg: clr.greenLight, border: clr.greenBorder, text: clr.green }
    : { bg: clr.blueLight, border: clr.blueBorder, text: clr.blue };
  return (
    <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 6, padding: '8px 12px', fontSize: 12, color: c.text, marginBottom: 12 }}>
      {children}
    </div>
  );
}

function Card({ title, color, children }: { title: string; color: 'green' | 'blue'; children: ReactNode }) {
  const c = color === 'green'
    ? { border: clr.greenBorder, head: clr.green }
    : { border: clr.blueBorder, head: clr.blue };
  return (
    <div style={{ flex: 1, border: `1px solid ${c.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ background: c.head, color: '#fff', padding: '8px 14px', fontWeight: 600, fontSize: 13 }}>
        {title}
      </div>
      <div style={{ padding: '14px 14px' }}>{children}</div>
    </div>
  );
}

function btnStyle(color: string, small = false): CSSProperties {
  return {
    padding: small ? '8px 16px' : '8px 20px',
    fontSize: small ? 13 : 13,
    background: color,
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontWeight: 600,
  };
}
