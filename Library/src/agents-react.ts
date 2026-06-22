/**
 * @palinc/nirnam/agents/react
 * React hooks for NirnamAgent. Peer dependency: react >= 17.
 */

import * as React from 'react';
import { createAgent } from './agents/agent';
import type { NirnamAgent } from './agents/agent';
import type { AgentConfig, AgentStatus, Message } from './agents/types';

let _idCounter = 0;
function genId(): string { return `msg-${++_idCounter}`; }

/**
 * Create an agent tied to a React component's lifecycle.
 * The agent is created on mount and destroyed on unmount.
 * Config is read once at mount — changes to config after mount are ignored.
 */
export function useAgent(config: AgentConfig): NirnamAgent | null {
  const [agent, setAgent] = React.useState<NirnamAgent | null>(null);
  const configRef = React.useRef(config);

  React.useEffect(() => {
    const a = createAgent(configRef.current);
    setAgent(a);
    return () => { a.destroy(); setAgent(null); };
  }, []);

  return agent;
}

export interface AgentChatState {
  messages: Message[];
  send: (text: string) => void;
  isStreaming: boolean;
  error: Error | null;
  clearMessages: () => void;
}

/**
 * Manages chat state for an active agent.
 * Uses chatStream() internally so text appears incrementally.
 */
export function useAgentChat(agent: NirnamAgent | null): AgentChatState {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const send = React.useCallback((text: string) => {
    if (!agent || isStreaming) return;

    // Cancel any in-flight stream
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setIsStreaming(true);
    setError(null);

    const userMsg: Message = { id: genId(), role: 'user', content: text, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);

    const streamId = genId();
    let accumulated = '';

    (async () => {
      try {
        for await (const chunk of agent.chatStream(text, { signal: ctrl.signal })) {
          accumulated += chunk;
          const assistantMsg: Message = {
            id: streamId,
            role: 'assistant',
            content: accumulated,
            timestamp: Date.now(),
          };
          setMessages(prev => {
            const exists = prev.some(m => m.id === streamId);
            if (exists) return prev.map(m => m.id === streamId ? assistantMsg : m);
            return [...prev, assistantMsg];
          });
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err as Error);
        }
      } finally {
        setIsStreaming(false);
      }
    })();
  }, [agent, isStreaming]);

  const clearMessages = React.useCallback(() => {
    agent?.clearHistory();
    setMessages([]);
  }, [agent]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  return { messages, send, isStreaming, error, clearMessages };
}

/**
 * Subscribe to an agent's status changes.
 */
export function useAgentStatus(agent: NirnamAgent | null): AgentStatus {
  const [status, setStatus] = React.useState<AgentStatus>(
    agent ? agent.status : 'initializing',
  );

  React.useEffect(() => {
    if (!agent) return;
    setStatus(agent.status);
    return agent.onStatusChange(setStatus);
  }, [agent]);

  return status;
}
