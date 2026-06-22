import React, { useState } from "react";
import LlmConfig from "./components/LlmConfig";
import ChatTab from "./components/ChatTab";
import MonitorTab from "./components/MonitorTab";
import PipelineTab from "./components/PipelineTab";
import type { RealLLMConfig } from "@palinc/nirnam/agents";

type Tab = "chat" | "monitor" | "pipeline";

const DEFAULT_LLM: RealLLMConfig = {
  url: "http://localhost:11434/v1",
  model: "llama3.2",
  provider: "openai-compat",
};

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [llm, setLlm] = useState<RealLLMConfig>(DEFAULT_LLM);
  const [configVersion, setConfigVersion] = useState(0);

  const applyConfig = () => setConfigVersion(v => v + 1);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto", padding: "20px 24px" }}>
      <h1 style={{ margin: "0 0 4px" }}>Nirnam · Agents API</h1>
      <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 16px" }}>
        Demonstrates <code>createAgent</code>, <code>useAgent</code>, <code>useAgentChat</code>,
        tool use, passive processing, and multi-agent pipelines.
        Requires a running LLM — defaults to Ollama at <code>localhost:11434</code>.
      </p>

      <LlmConfig value={llm} onChange={setLlm} onApply={applyConfig} />

      <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "1px solid #e5e7eb" }}>
        {(["chat", "monitor", "pipeline"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: "none",
              border: "none",
              borderBottom: tab === t ? "2px solid #1d4ed8" : "2px solid transparent",
              padding: "8px 20px",
              fontSize: 14,
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? "#1d4ed8" : "#6b7280",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "chat"     && <ChatTab     key={configVersion} llm={llm} />}
      {tab === "monitor"  && <MonitorTab  key={configVersion} llm={llm} />}
      {tab === "pipeline" && <PipelineTab key={configVersion} llm={llm} />}
    </div>
  );
}
