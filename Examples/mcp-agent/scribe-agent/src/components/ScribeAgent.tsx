import React, { useEffect, useState } from "react";
import { createBus } from "@shaurcasm/nirnam";
import { NirnamMCPTransport } from "@shaurcasm/nirnam/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const bus = createBus();

interface QAEntry {
  question: string;
  answer: string;
  timestamp: string;
}

// Module-level state — persists across React re-renders
const entries: QAEntry[] = [];

function buildMarkdown(title = "Q&A Document"): string {
  if (entries.length === 0) return `# ${title}\n\n*No questions recorded yet.*`;
  const body = entries
    .map(
      (e, i) =>
        `## Q${i + 1}: ${e.question}\n\n${e.answer}\n\n*Recorded at ${e.timestamp}*`
    )
    .join("\n\n---\n\n");
  return `# ${title}\n\n${body}`;
}

async function startServer(onStatus: (s: string) => void) {
  const transport = new NirnamMCPTransport({ agentId: "scribe-agent", bus });
  const server = new McpServer({ name: "scribe-agent", version: "1.0.0" });

  // Tool: record a Q&A pair
  server.tool(
    "record",
    "Record a question and its answer into the Q&A document.",
    {
      question: z.string().describe("The question that was asked"),
      answer: z.string().describe("The answer to record"),
    },
    async ({ question, answer }) => {
      entries.push({
        question,
        answer,
        timestamp: new Date().toLocaleTimeString(),
      });
      onStatus(`${entries.length} question${entries.length === 1 ? "" : "s"} recorded`);
      return {
        content: [
          { type: "text", text: `Recorded Q${entries.length}: "${question}"` },
        ],
      };
    }
  );

  // Tool: get the full Q&A markdown document
  server.tool(
    "get_document",
    "Return the accumulated Q&A pairs as a structured markdown document.",
    {
      title: z
        .string()
        .optional()
        .describe("Document title (default: 'Q&A Document')"),
    },
    async ({ title }) => {
      return {
        content: [{ type: "text", text: buildMarkdown(title) }],
      };
    }
  );

  // Tool: clear all recorded Q&A pairs
  server.tool(
    "clear",
    "Clear all recorded questions and answers.",
    {},
    async () => {
      const count = entries.length;
      entries.length = 0;
      onStatus("0 questions recorded");
      return {
        content: [
          { type: "text", text: `Cleared ${count} entries.` },
        ],
      };
    }
  );

  bus.register({
    agentId: "scribe-agent",
    capabilities: ["record", "get_document", "clear"],
    metadata: { type: "scribe" },
  });

  await server.connect(transport);
  onStatus("0 questions recorded");
}

export default function ScribeAgent() {
  const [status, setStatus] = useState("starting...");

  useEffect(() => {
    startServer(setStatus).catch((e) =>
      setStatus(`Error: ${(e as Error).message}`)
    );
  }, []);

  return (
    <div
      style={{
        padding: 12,
        background: "#f0fff4",
        borderRadius: 8,
        fontSize: 13,
      }}
    >
      <strong>ScribeAgent</strong>{" "}
      <span style={{ color: "#666" }}>(MCP server · port 3002)</span>
      <div style={{ marginTop: 4, color: "#444" }}>Status: {status}</div>
    </div>
  );
}
