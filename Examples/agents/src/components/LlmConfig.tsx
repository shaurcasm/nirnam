import React from "react";
import type { LLMProvider, RealLLMConfig } from "@palinc/nirnam/agents";

function detectProvider(url: string): LLMProvider {
  if (url.includes("anthropic.com") || url.endsWith("/messages")) return "anthropic";
  return "openai-compat";
}

interface Props {
  value: RealLLMConfig;
  onChange: (c: RealLLMConfig) => void;
  onApply: () => void;
}

export default function LlmConfig({ value, onChange, onApply }: Props) {
  const update = (patch: Partial<RealLLMConfig>) => {
    const next = { ...value, ...patch };
    next.provider = detectProvider(next.url ?? "");
    onChange(next);
  };

  return (
    <div style={{
      background: "#f9fafb",
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      padding: "10px 14px",
      marginBottom: 16,
      display: "flex",
      gap: 12,
      flexWrap: "wrap",
      alignItems: "flex-end",
    }}>
      <label style={label}>
        LLM URL
        <input
          style={input}
          value={value.url ?? ""}
          onChange={e => update({ url: e.target.value })}
          placeholder="http://localhost:11434/v1"
        />
      </label>
      <label style={label}>
        Model
        <input
          style={{ ...input, width: 140 }}
          value={value.model ?? ""}
          onChange={e => update({ model: e.target.value })}
          placeholder="llama3.2"
        />
      </label>
      <label style={label}>
        API Key <span style={{ color: "#9ca3af", fontWeight: 400 }}>(optional)</span>
        <input
          style={{ ...input, width: 140 }}
          type="password"
          value={value.apiKey ?? ""}
          onChange={e => update({ apiKey: e.target.value || undefined })}
          placeholder="sk-…"
        />
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>
          PROVIDER: <span style={{ color: "#6b7280" }}>{value.provider ?? "openai-compat"}</span>
        </span>
        <button
          onClick={onApply}
          style={{
            background: "#1d4ed8",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "5px 14px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Apply &amp; Reconnect
        </button>
      </div>
    </div>
  );
}

const label: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  fontSize: 11,
  fontWeight: 600,
  color: "#374151",
};

const input: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 13,
  width: 220,
  outline: "none",
};
