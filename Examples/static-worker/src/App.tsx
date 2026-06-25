import { useState, useEffect, useCallback } from 'react';
import { createBus } from '@palinc/nirnam';

// Injected at build time by nirnamPlugin() in vite.config.ts.
// When the plugin is active this evaluates to the static worker URL string;
// without the plugin it remains undefined and the bus falls back to a Blob URL.
declare const __NIRNAM_STATIC_WORKER_URL__: string | undefined;

const WORKER_MODE =
  typeof __NIRNAM_STATIC_WORKER_URL__ === 'string'
    ? { label: 'Layer 3 — Static URL SharedWorker', url: __NIRNAM_STATIC_WORKER_URL__, color: '#16a34a' }
    : { label: 'Layer 2 — Blob URL SharedWorker', url: 'blob (plugin not active)', color: '#b45309' };

const bus = createBus();

interface Message {
  id: number;
  tab: string;
  text: string;
}

const TAB_ID = `Tab-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export default function App() {
  const [count, setCount] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    const unsubCount = bus.subscribe<number>('demo:count', (value) => {
      setCount(value);
    });
    const unsubMsg = bus.subscribe<Message>('demo:message', (msg) => {
      setMessages((prev) => [...prev.slice(-9), msg]);
    });
    return () => {
      unsubCount();
      unsubMsg();
      bus.close();
    };
  }, []);

  const increment = useCallback(() => {
    setCount((prev) => {
      const next = prev + 1;
      bus.publish('demo:count', next);
      return next;
    });
  }, []);

  const sendMessage = useCallback(() => {
    const msg: Message = {
      id: Date.now(),
      tab: TAB_ID,
      text: `Hello from ${TAB_ID} at ${new Date().toLocaleTimeString()}`,
    };
    bus.publish('demo:message', msg);
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 520, margin: '40px auto', padding: '0 20px' }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Nirnam — Static Worker Example</h1>
      <p style={{ fontSize: 12, color: '#6b7280', marginTop: 0 }}>This tab: <strong>{TAB_ID}</strong></p>

      <div style={{
        background: WORKER_MODE.color === '#16a34a' ? '#f0fdf4' : '#fffbeb',
        border: `1px solid ${WORKER_MODE.color === '#16a34a' ? '#86efac' : '#fde68a'}`,
        borderRadius: 8, padding: '10px 14px', marginBottom: 24, fontSize: 13,
      }}>
        <strong style={{ color: WORKER_MODE.color }}>Worker mode:</strong>{' '}
        {WORKER_MODE.label}
        <br />
        <code style={{ fontSize: 11, color: '#6b7280' }}>{WORKER_MODE.url}</code>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'center' }}>
        <div style={{ fontSize: 40, fontWeight: 'bold', minWidth: 60, textAlign: 'center' }}>{count}</div>
        <button
          onClick={increment}
          style={{
            padding: '8px 20px', fontSize: 15, cursor: 'pointer',
            background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6,
          }}
        >
          Increment counter
        </button>
      </div>

      <button
        onClick={sendMessage}
        style={{
          padding: '7px 16px', fontSize: 13, cursor: 'pointer', marginBottom: 16,
          background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6,
        }}
      >
        Send message from this tab
      </button>

      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
          CROSS-TAB MESSAGES (last 10)
        </div>
        {messages.length === 0 ? (
          <p style={{ fontSize: 12, color: '#9ca3af' }}>
            No messages yet — open a second tab and click the button above.
          </p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              style={{
                fontSize: 12, padding: '4px 8px', marginBottom: 4,
                background: m.tab === TAB_ID ? '#eff6ff' : '#f5f3ff',
                border: `1px solid ${m.tab === TAB_ID ? '#bfdbfe' : '#ddd6fe'}`,
                borderRadius: 4,
              }}
            >
              <strong>{m.tab}</strong>: {m.text.replace(`Hello from ${m.tab} at `, '')}
            </div>
          ))
        )}
      </div>

      <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 24, lineHeight: 1.6 }}>
        Open this page in multiple tabs and click the buttons.
        With <strong>Layer 3</strong>, all tabs share the same SharedWorker instance
        — messages route through a single process, enabling true cross-tab state sharing
        without BroadcastChannel.
      </p>
    </div>
  );
}
