import React, { useEffect, useState } from "react";
import { createBus } from "@palinc/nirnam";
import { NirnamMCPTransport } from "@palinc/nirnam/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const bus = createBus();

async function startCalcServer() {
  const transport = new NirnamMCPTransport({ agentId: "calc-agent", bus });

  const server = new McpServer({
    name: "calc-agent",
    version: "1.0.0",
  });

  server.tool(
    "add",
    "Add two numbers",
    { a: z.number(), b: z.number() },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    })
  );

  server.tool(
    "multiply",
    "Multiply two numbers",
    { a: z.number(), b: z.number() },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a * b) }],
    })
  );

  await bus.register({
    agentId: "calc-agent",
    capabilities: ["add", "multiply"],
    metadata: { type: "mcp-server" },
  });

  await server.connect(transport);
  console.log("[CalcAgent] MCP server started, registered as calc-agent");
}

export default function CalcAgent() {
  const [status, setStatus] = useState("starting...");

  useEffect(() => {
    startCalcServer()
      .then(() => setStatus("ready — tools: add, multiply"))
      .catch((e) => setStatus(`error: ${e.message}`));
  }, []);

  return (
    <div style={{ padding: 16, background: "#f0f9ff", borderRadius: 8 }}>
      <strong>CalcAgent (MCP Server)</strong>
      <p style={{ margin: "4px 0 0" }}>Status: {status}</p>
    </div>
  );
}
