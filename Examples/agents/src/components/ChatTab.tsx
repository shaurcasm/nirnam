import React, { useState } from "react";
import { useAgent, useAgentChat, useAgentStatus } from "@palinc/nirnam/agents/react";
import type { RealLLMConfig, ToolDefinition } from "@palinc/nirnam/agents";

// Three local tools the agent can call.
const TOOLS: ToolDefinition[] = [
  {
    name: "calculate",
    description: "Evaluate a simple arithmetic expression and return the result",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: 'Arithmetic to evaluate, e.g. "12 * 34 + 5"' },
      },
      required: ["expression"],
    },
    execute: async ({ expression }: { expression: string }) => {
      try {
        // Strip anything that is not a number or arithmetic operator before eval.
        const safe = expression.replace(/[^0-9+\-*/.()\s]/g, "");
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${safe})`)();
        return String(result);
      } catch {
        return "Could not evaluate expression";
      }
    },
  },
  {
    name: "get_current_time",
    description: "Return the current date and time",
    inputSchema: { type: "object", properties: {} },
    execute: async () => new Date().toLocaleString(),
  },
  {
    name: "reverse_text",
    description: "Reverse the characters in a string",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The string to reverse" } },
      required: ["text"],
    },
    execute: async ({ text }: { text: string }) => [...text].reverse().join(""),
  },
];

export default function ChatTab({ llm }: { llm: RealLLMConfig }) {
  const [input, setInput] = useState("");

  // useAgent creates the agent once on mount and destroys it on unmount.
  // The parent re-keys this component when the user clicks "Apply & Reconnect".
  const agent = useAgent({ llm, tools: TOOLS, autoCleanup: false });
  const { messages, send, isStreaming, error, clearMessages } = useAgentChat(agent);
  const status = useAgentStatus(agent);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming || !agent) return;
    send(text);
    setInput("");
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge status={status} />
          <span style={{ color: "#6b7280" }}>
            {messages.length} message{messages.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>
            tools: calculate · get_current_time · reverse_text
          </span>
          <button
            onClick={clearMessages}
            style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer", color: "#6b7280" }}
          >
            Clear
          </button>
        </div>
      </div>

      <div style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        height: 400,
        overflowY: "auto",
        padding: "12px",
        background: "#f9fafb",
        marginBottom: 10,
      }}>
        {messages.length === 0 && (
          <div style={{ color: "#9ca3af", fontSize: 13 }}>
            <p style={{ margin: "0 0 8px" }}>Try asking something that exercises a tool:</p>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
              <li>"What is 42 × 137 + 99?"</li>
              <li>"What time is it right now?"</li>
              <li>"Reverse the word 'Nirnam'"</li>
              <li>"Explain micro-frontend architecture"</li>
            </ul>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: m.role === "user" ? "#1d4ed8" : "#059669", marginBottom: 3, letterSpacing: 1 }}>
              {m.role === "user" ? "YOU" : "AGENT"}
            </div>
            <div style={{
              background: m.role === "user" ? "#dbeafe" : "#fff",
              border: "1px solid",
              borderColor: m.role === "user" ? "#93c5fd" : "#e5e7eb",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 13,
              whiteSpace: "pre-wrap",
              lineHeight: 1.5,
            }}>
              {m.content}
            </div>
          </div>
        ))}
        {isStreaming && (
          <div style={{ color: "#059669", fontSize: 12, fontStyle: "italic" }}>● Agent is responding…</div>
        )}
        {error && (
          <div style={{ color: "#dc2626", fontSize: 12, background: "#fee2e2", borderRadius: 6, padding: "6px 10px", marginTop: 8 }}>
            <strong>Error:</strong> {error.message}
          </div>
        )}
      </div>

      <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={agent ? "Ask anything…" : "Connecting to agent…"}
          disabled={!agent || isStreaming}
          style={{
            flex: 1,
            border: "1px solid #d1d5db",
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 13,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!agent || isStreaming || !input.trim()}
          style={{
            background: "#1d4ed8",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "9px 18px",
            fontSize: 13,
            cursor: "pointer",
            opacity: (!agent || isStreaming || !input.trim()) ? 0.5 : 1,
          }}
        >
          {isStreaming ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: "#059669",
    active: "#2563eb",
    initializing: "#9ca3af",
    stopping: "#f59e0b",
    stopped: "#6b7280",
    error: "#dc2626",
  };
  return (
    <span style={{
      background: colors[status] ?? "#6b7280",
      color: "#fff",
      borderRadius: 12,
      padding: "2px 10px",
      fontSize: 11,
      fontWeight: 600,
    }}>
      {status}
    </span>
  );
}
