import React, { useState } from "react";
import { useAgent, useAgentChat, useAgentStatus } from "@palinc/nirnam/agents/react";
import { presets, withPreset } from "@palinc/nirnam/agents";
import type { RealLLMConfig } from "@palinc/nirnam/agents";

export default function FilesystemTab({ llm }: { llm: RealLLMConfig }) {
  const [folderName, setFolderName] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [grantError, setGrantError] = useState<string | null>(null);

  // Read-only code-review preset: list_directory + read_file, focused system prompt.
  // Config is captured once at mount — component is re-keyed by parent on LLM change.
  const agent = useAgent(withPreset(presets.codeReview(), { llm, autoCleanup: false }));
  const { messages, send, isStreaming, error, clearMessages } = useAgentChat(agent);
  const status = useAgentStatus(agent);

  const grantAccess = async () => {
    if (!agent) return;
    setGrantError(null);
    try {
      const handle = await agent.requestFolderAccess({ mode: "read" });
      setFolderName(handle.name);
    } catch (e) {
      // AbortError = user cancelled the picker — not an error worth showing.
      if ((e as Error).name !== "AbortError") {
        setGrantError("Could not access folder. Please try again.");
      }
    }
  };

  const revokeAccess = () => {
    agent?.revokeFolder();
    setFolderName(null);
    clearMessages();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming || !agent || !folderName) return;
    send(text);
    setInput("");
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge status={status} />
          {folderName && (
            <span style={{
              background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 6,
              padding: "2px 10px", fontSize: 12, color: "#15803d", fontFamily: "monospace",
            }}>
              /{folderName}
            </span>
          )}
          {folderName && (
            <span style={{ fontSize: 11, color: "#9ca3af" }}>
              tools: read_file · list_directory
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {folderName ? (
            <>
              <button
                onClick={grantAccess}
                disabled={!agent}
                title="Switch to a different folder"
                style={{
                  background: "none", border: "1px solid #d1d5db", borderRadius: 6,
                  padding: "4px 12px", fontSize: 12, cursor: "pointer", color: "#374151",
                }}
              >
                Switch Folder
              </button>
              <button
                onClick={revokeAccess}
                style={{
                  background: "none", border: "1px solid #fca5a5", borderRadius: 6,
                  padding: "4px 12px", fontSize: 12, cursor: "pointer", color: "#dc2626",
                }}
              >
                Revoke Access
              </button>
            </>
          ) : (
            <button
              onClick={grantAccess}
              disabled={!agent}
              style={{
                background: "#1d4ed8", color: "#fff", border: "none",
                borderRadius: 6, padding: "6px 14px", fontSize: 13,
                cursor: "pointer", opacity: !agent ? 0.5 : 1,
              }}
            >
              Grant Folder Access
            </button>
          )}
        </div>
      </div>

      {/* Pre-grant banner */}
      {!folderName && (
        <div style={{
          border: "1px dashed #d1d5db", borderRadius: 8, padding: "20px 24px",
          textAlign: "center", marginBottom: 12, background: "#f9fafb",
        }}>
          <p style={{ margin: "0 0 6px", fontSize: 14, color: "#374151", fontWeight: 500 }}>
            Point the agent at a folder on your machine
          </p>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "#6b7280" }}>
            The browser will show a folder picker. The agent can then read and analyse your
            files — <strong>nothing leaves your tab</strong>. No upload, no server.
          </p>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>
            Works best pointed at a code project. Try asking it to summarise the README or review a specific file.
          </p>
          {grantError && (
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "#dc2626" }}>{grantError}</p>
          )}
        </div>
      )}

      {/* Chat window */}
      <div style={{
        border: "1px solid #e5e7eb", borderRadius: 8,
        height: folderName ? 380 : 260,
        overflowY: "auto", padding: 12, background: "#f9fafb", marginBottom: 10,
      }}>
        {messages.length === 0 && folderName && (
          <div style={{ color: "#9ca3af", fontSize: 13 }}>
            <p style={{ margin: "0 0 8px" }}>
              <strong style={{ color: "#374151" }}>{folderName}</strong> is ready. Try:
            </p>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
              <li>"List all files in this folder"</li>
              <li>"Read the README and summarise what this project does"</li>
              <li>"What does the main entry point do?"</li>
              <li>"Review App.tsx for any obvious bugs"</li>
            </ul>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} style={{ marginBottom: 14 }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 3,
              color: m.role === "user" ? "#1d4ed8" : "#059669",
            }}>
              {m.role === "user" ? "YOU" : "AGENT"}
            </div>
            <div style={{
              background: m.role === "user" ? "#dbeafe" : "#fff",
              border: "1px solid",
              borderColor: m.role === "user" ? "#93c5fd" : "#e5e7eb",
              borderRadius: 8, padding: "8px 12px",
              fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5,
            }}>
              {m.content}
            </div>
          </div>
        ))}
        {isStreaming && (
          <div style={{ color: "#059669", fontSize: 12, fontStyle: "italic" }}>
            ● Agent is responding…
          </div>
        )}
        {error && (
          <div style={{
            color: "#dc2626", fontSize: 12, background: "#fee2e2",
            borderRadius: 6, padding: "6px 10px", marginTop: 8,
          }}>
            <strong>Error:</strong> {error.message}
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={
            !folderName
              ? "Grant folder access to start chatting…"
              : !agent
              ? "Connecting to agent…"
              : "Ask about your files…"
          }
          disabled={!agent || isStreaming || !folderName}
          style={{
            flex: 1, border: "1px solid #d1d5db", borderRadius: 8,
            padding: "9px 12px", fontSize: 13, outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!agent || isStreaming || !input.trim() || !folderName}
          style={{
            background: "#1d4ed8", color: "#fff", border: "none",
            borderRadius: 8, padding: "9px 18px", fontSize: 13, cursor: "pointer",
            opacity: (!agent || isStreaming || !input.trim() || !folderName) ? 0.5 : 1,
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
      background: colors[status] ?? "#6b7280", color: "#fff",
      borderRadius: 12, padding: "2px 10px", fontSize: 11, fontWeight: 600,
    }}>
      {status}
    </span>
  );
}
