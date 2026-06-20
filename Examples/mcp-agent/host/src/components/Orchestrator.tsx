import React, { useEffect, useState } from "react";
import { createBus } from "@shaurcasm/nirnam";
import { NirnamMCPTransport } from "@shaurcasm/nirnam/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const bus = createBus();

interface Tool {
  name: string;
  description?: string;
}

interface LogEntry {
  id: number;
  text: string;
}

let logId = 0;

export default function Orchestrator() {
  const [client, setClient] = useState<Client | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [a, setA] = useState("3");
  const [b, setB] = useState("7");
  const [op, setOp] = useState("add");

  function addLog(text: string) {
    setLog((prev) => [...prev, { id: logId++, text }]);
  }

  useEffect(() => {
    const transport = new NirnamMCPTransport({
      agentId: "orchestrator",
      targetAgentId: "calc-agent",
      bus,
    });

    const mcpClient = new Client(
      { name: "orchestrator", version: "1.0.0" },
      { capabilities: {} }
    );

    mcpClient.connect(transport).then(async () => {
      addLog("Connected to calc-agent via Nirnam MCP transport");
      const { tools: toolList } = await mcpClient.listTools();
      setTools(toolList as Tool[]);
      addLog(`Discovered tools: ${toolList.map((t: Tool) => t.name).join(", ")}`);
    });

    setClient(mcpClient);

    return () => { mcpClient.close(); };
  }, []);

  async function callTool() {
    if (!client) return;
    const numA = parseFloat(a);
    const numB = parseFloat(b);
    addLog(`Calling ${op}(${numA}, ${numB})...`);
    try {
      const result = await client.callTool({ name: op, arguments: { a: numA, b: numB } });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "?";
      addLog(`Result: ${text}`);
    } catch (e) {
      addLog(`Error: ${(e as Error).message}`);
    }
  }

  return (
    <div style={{ padding: 16, background: "#f0fff4", borderRadius: 8 }}>
      <strong>Orchestrator (MCP Client)</strong>

      <div style={{ margin: "12px 0" }}>
        <input
          value={a}
          onChange={(e) => setA(e.target.value)}
          style={{ width: 60, marginRight: 8 }}
          type="number"
        />
        <select value={op} onChange={(e) => setOp(e.target.value)} style={{ marginRight: 8 }}>
          {tools.map((t) => (
            <option key={t.name} value={t.name}>{t.name}</option>
          ))}
        </select>
        <input
          value={b}
          onChange={(e) => setB(e.target.value)}
          style={{ width: 60, marginRight: 8 }}
          type="number"
        />
        <button onClick={callTool} disabled={tools.length === 0}>
          Call
        </button>
      </div>

      <pre style={{ background: "#e6f7e6", padding: 8, borderRadius: 4, fontSize: 12, maxHeight: 200, overflow: "auto" }}>
        {log.map((e) => <div key={e.id}>{e.text}</div>)}
      </pre>
    </div>
  );
}
