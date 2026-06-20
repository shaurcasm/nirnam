import React, { Suspense, lazy } from "react";
import Orchestrator from "./components/Orchestrator";

const OllamaAgent = lazy(() => import("ollama_agent/OllamaAgent"));
const ScribeAgent = lazy(() => import("scribe_agent/ScribeAgent"));

function AgentBar() {
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
      <Suspense fallback={<div style={agentPlaceholder}>Loading OllamaAgent…</div>}>
        <div style={{ flex: 1 }}>
          <OllamaAgent />
        </div>
      </Suspense>
      <Suspense fallback={<div style={agentPlaceholder}>Loading ScribeAgent…</div>}>
        <div style={{ flex: 1 }}>
          <ScribeAgent />
        </div>
      </Suspense>
    </div>
  );
}

const agentPlaceholder: React.CSSProperties = {
  flex: 1,
  padding: 12,
  background: "#f3f4f6",
  borderRadius: 8,
  fontSize: 13,
  color: "#9ca3af",
};

export default function App() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: 24,
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Nirnam · Document Q&A</h1>
      <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 20px" }}>
        Load a markdown document → ask questions via a local Ollama LLM →
        ScribeAgent records every Q&A pair into a downloadable markdown file.
      </p>

      {/* Loading the remote MFEs also starts their MCP servers */}
      <AgentBar />

      <Orchestrator />
    </div>
  );
}
