import React from "react";
import OllamaAgent from "./components/OllamaAgent";

export default function App() {
  return (
    <div style={{ fontFamily: "sans-serif", padding: 24 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>ollama-agent remote</h2>
      <OllamaAgent />
    </div>
  );
}
