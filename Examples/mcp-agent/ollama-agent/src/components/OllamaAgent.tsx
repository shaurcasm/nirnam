import React, { useEffect, useState } from "react";
import { createBus } from "@shaurcasm/nirnam";
import { NirnamMCPTransport } from "@shaurcasm/nirnam/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Module-level state: survives React re-renders because the MFE module
// is loaded once and shared via the SharedWorker singleton.
const bus = createBus();
let documentContent = "";
let wordCount = 0;

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function ollamaChat(
  messages: OllamaMessage[],
  model = "llama3.2"
): Promise<string> {
  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.message?.content ?? "";
}

async function startServer(onStatus: (s: string) => void) {
  const transport = new NirnamMCPTransport({ agentId: "ollama-agent", bus });
  const server = new McpServer({ name: "ollama-agent", version: "1.0.0" });

  // Tool: load a markdown document into context
  server.tool(
    "load_document",
    "Load a markdown document for analysis. Call this before asking questions.",
    { content: z.string().describe("The full markdown document text") },
    async ({ content }) => {
      documentContent = content;
      wordCount = content.trim().split(/\s+/).length;

      // Generate a brief summary so the host can confirm the doc was understood
      const summary = await ollamaChat([
        {
          role: "system",
          content:
            "You are a document analyst. Summarise the following document in 2-3 sentences, mentioning the main topic and key points.",
        },
        { role: "user", content },
      ]);

      onStatus(`Document loaded — ${wordCount} words`);
      return {
        content: [
          {
            type: "text",
            text: `Document loaded (${wordCount} words).\n\nSummary:\n${summary}`,
          },
        ],
      };
    }
  );

  // Tool: ask a question about the loaded document
  server.tool(
    "ask",
    "Ask a question about the currently loaded document.",
    {
      question: z.string().describe("The question to ask about the document"),
      model: z
        .string()
        .optional()
        .describe("Ollama model to use (default: llama3.2)"),
    },
    async ({ question, model }) => {
      if (!documentContent) {
        return {
          content: [
            {
              type: "text",
              text: "No document loaded. Call load_document first.",
            },
          ],
          isError: true,
        };
      }

      const answer = await ollamaChat(
        [
          {
            role: "system",
            content: `You are a helpful document analyst. Answer the user's question based ONLY on the document below. If the answer is not in the document, say so.\n\n---\n\n${documentContent}`,
          },
          { role: "user", content: question },
        ],
        model ?? "llama3.2"
      );

      return { content: [{ type: "text", text: answer }] };
    }
  );

  bus.register({
    agentId: "ollama-agent",
    capabilities: ["load_document", "ask"],
    metadata: { type: "llm-agent", backend: "ollama" },
  });

  await server.connect(transport);
  onStatus("Ready — waiting for document");
}

export default function OllamaAgent() {
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
        background: "#f5f0ff",
        borderRadius: 8,
        fontSize: 13,
      }}
    >
      <strong>OllamaAgent</strong>{" "}
      <span style={{ color: "#666" }}>(MCP server · port 3001)</span>
      <div style={{ marginTop: 4, color: "#444" }}>Status: {status}</div>
    </div>
  );
}
