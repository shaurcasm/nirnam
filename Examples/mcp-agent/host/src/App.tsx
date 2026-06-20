import React, { Suspense, lazy } from "react";
import Orchestrator from "./components/Orchestrator";

const CalcAgent = lazy(() => import("mcp_remote/CalcAgent"));

export default function App() {
  return (
    <div style={{ fontFamily: "sans-serif", padding: 24, maxWidth: 600 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Nirnam MCP Agent Demo</h1>
      <p style={{ color: "#666", margin: "0 0 20px" }}>
        The remote MFE loads a calculator MCP server. The host connects to it via{" "}
        <code>NirnamMCPTransport</code> and calls its tools.
      </p>

      <Suspense fallback={<div>Loading remote agent...</div>}>
        <CalcAgent />
      </Suspense>

      <div style={{ marginTop: 16 }}>
        <Orchestrator />
      </div>
    </div>
  );
}
