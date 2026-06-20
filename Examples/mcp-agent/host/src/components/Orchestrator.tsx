import React, { useEffect, useRef, useState, useCallback } from "react";
import { createBus } from "@shaurcasm/nirnam";
import { NirnamMCPTransport } from "@shaurcasm/nirnam/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// One bus shared across the entire host page.
// Module Federation + singleton sharing means this is the SAME SharedWorker
// process that the OllamaAgent and ScribeAgent remotes connect to.
const bus = createBus();

type ClientStatus = "connecting" | "ready" | "error";

interface QAItem {
  id: number;
  question: string;
  answer: string;
}

let qaId = 0;

// ---- hook: create and connect an MCP client to a target agent ---------------

function useMcpClient(
  ownAgentId: string,
  targetAgentId: string
): { client: Client | null; status: ClientStatus; error: string } {
  const [status, setStatus] = useState<ClientStatus>("connecting");
  const [error, setError] = useState("");
  const clientRef = useRef<Client | null>(null);

  useEffect(() => {
    const transport = new NirnamMCPTransport({ agentId: ownAgentId, targetAgentId, bus });
    const client = new Client({ name: ownAgentId, version: "1.0.0" }, { capabilities: {} });
    clientRef.current = client;

    client
      .connect(transport)
      .then(() => setStatus("ready"))
      .catch((e: Error) => {
        setStatus("error");
        setError(e.message);
      });

    return () => { client.close(); };
  }, [ownAgentId, targetAgentId]);

  return { client: clientRef.current, status, error };
}

// ---- sub-components ---------------------------------------------------------

function StatusBadge({ status, label }: { status: ClientStatus; label: string }) {
  const color = status === "ready" ? "#16a34a" : status === "error" ? "#dc2626" : "#d97706";
  return (
    <span style={{ fontSize: 12, color, fontWeight: 600 }}>
      {label}: {status}
    </span>
  );
}

// ---- Document Panel ---------------------------------------------------------

function DocumentPanel({
  onLoad,
  loading,
  summary,
}: {
  onLoad: (text: string) => Promise<void>;
  loading: boolean;
  summary: string;
}) {
  const [text, setText] = useState("");

  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>1. Load Document</h2>
      <p style={hintStyle}>Paste or type a markdown document. OllamaAgent will read and summarise it.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="# My Document&#10;&#10;Paste markdown here..."
        rows={10}
        style={{ ...inputStyle, fontFamily: "monospace", fontSize: 13 }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <button
          onClick={() => onLoad(text)}
          disabled={loading || !text.trim()}
          style={buttonStyle(loading || !text.trim())}
        >
          {loading ? "Loading…" : "Load Document"}
        </button>
        {summary && (
          <span style={{ fontSize: 12, color: "#555", flex: 1 }}>✓ {summary}</span>
        )}
      </div>
    </section>
  );
}

// ---- Q&A Panel --------------------------------------------------------------

function QAPanel({
  onAsk,
  items,
  asking,
  docLoaded,
}: {
  onAsk: (q: string) => Promise<void>;
  items: QAItem[];
  asking: boolean;
  docLoaded: boolean;
}) {
  const [question, setQuestion] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  const submit = async () => {
    if (!question.trim()) return;
    const q = question;
    setQuestion("");
    await onAsk(q);
  };

  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>2. Ask Questions</h2>
      {!docLoaded && (
        <p style={{ ...hintStyle, color: "#b45309" }}>Load a document first.</p>
      )}

      <div
        style={{
          minHeight: 120,
          maxHeight: 280,
          overflowY: "auto",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          padding: 12,
          marginBottom: 8,
          background: "#fafafa",
        }}
      >
        {items.length === 0 && (
          <p style={{ color: "#aaa", fontSize: 13, margin: 0 }}>
            Answers will appear here…
          </p>
        )}
        {items.map((item) => (
          <div key={item.id} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>
              Q: {item.question}
            </div>
            <div style={{ color: "#374151", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {item.answer}
            </div>
          </div>
        ))}
        {asking && (
          <div style={{ color: "#9ca3af", fontSize: 13, fontStyle: "italic" }}>
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && submit()}
          placeholder="Ask a question about the document…"
          disabled={!docLoaded || asking}
          style={{ ...inputStyle, flex: 1, padding: "8px 12px" }}
        />
        <button
          onClick={submit}
          disabled={!docLoaded || asking || !question.trim()}
          style={buttonStyle(!docLoaded || asking || !question.trim())}
        >
          Ask
        </button>
      </div>
    </section>
  );
}

// ---- Q&A Document Panel -----------------------------------------------------

function DocPanel({
  markdown,
  onRefresh,
  onClear,
  refreshing,
}: {
  markdown: string;
  onRefresh: () => Promise<void>;
  onClear: () => Promise<void>;
  refreshing: boolean;
}) {
  function download() {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "qa-document.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>3. Q&A Document</h2>
      <p style={hintStyle}>ScribeAgent tracks all questions and answers.</p>
      <pre
        style={{
          background: "#f8fafc",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          padding: 12,
          fontSize: 12,
          minHeight: 120,
          maxHeight: 300,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          lineHeight: 1.6,
        }}
      >
        {markdown || "No entries yet."}
      </pre>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={onRefresh} disabled={refreshing} style={buttonStyle(refreshing)}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button onClick={download} disabled={!markdown} style={buttonStyle(!markdown)}>
          Download .md
        </button>
        <button
          onClick={onClear}
          style={{ ...buttonStyle(false), background: "#fee2e2", color: "#991b1b" }}
        >
          Clear
        </button>
      </div>
    </section>
  );
}

// ---- Main Orchestrator ------------------------------------------------------

export default function Orchestrator() {
  const { client: ollamaClient, status: ollamaStatus } = useMcpClient(
    "host-ollama",
    "ollama-agent"
  );
  const { client: scribeClient, status: scribeStatus } = useMcpClient(
    "host-scribe",
    "scribe-agent"
  );

  const [docLoaded, setDocLoaded] = useState(false);
  const [docSummary, setDocSummary] = useState("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [qaItems, setQaItems] = useState<QAItem[]>([]);
  const [asking, setAsking] = useState(false);
  const [qaMarkdown, setQaMarkdown] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  // Extract tool-call result text
  function extractText(result: unknown): string {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    return r?.content?.[0]?.text ?? "";
  }

  const loadDocument = useCallback(
    async (text: string) => {
      if (!ollamaClient) return;
      setLoadingDoc(true);
      try {
        const result = await ollamaClient.callTool({
          name: "load_document",
          arguments: { content: text },
        });
        const msg = extractText(result);
        // First line is "Document loaded (N words)." — use it as summary
        setDocSummary(msg.split("\n")[0]);
        setDocLoaded(true);
      } finally {
        setLoadingDoc(false);
      }
    },
    [ollamaClient]
  );

  const askQuestion = useCallback(
    async (question: string) => {
      if (!ollamaClient || !scribeClient) return;
      setAsking(true);
      try {
        // 1. Ask OllamaAgent
        const answerResult = await ollamaClient.callTool({
          name: "ask",
          arguments: { question },
        });
        const answer = extractText(answerResult);

        // 2. Record in ScribeAgent
        await scribeClient.callTool({
          name: "record",
          arguments: { question, answer },
        });

        // 3. Update local display
        setQaItems((prev) => [...prev, { id: qaId++, question, answer }]);

        // 4. Refresh the markdown document
        await refreshDoc();
      } finally {
        setAsking(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ollamaClient, scribeClient]
  );

  const refreshDoc = useCallback(async () => {
    if (!scribeClient) return;
    setRefreshing(true);
    try {
      const result = await scribeClient.callTool({ name: "get_document", arguments: {} });
      setQaMarkdown(extractText(result));
    } finally {
      setRefreshing(false);
    }
  }, [scribeClient]);

  const clearDoc = useCallback(async () => {
    if (!scribeClient) return;
    await scribeClient.callTool({ name: "clear", arguments: {} });
    setQaItems([]);
    setQaMarkdown("");
  }, [scribeClient]);

  return (
    <div>
      {/* Agent connection status */}
      <div
        style={{
          display: "flex",
          gap: 16,
          padding: "8px 0 16px",
          borderBottom: "1px solid #e5e7eb",
          marginBottom: 16,
        }}
      >
        <StatusBadge status={ollamaStatus} label="OllamaAgent" />
        <StatusBadge status={scribeStatus} label="ScribeAgent" />
      </div>

      <DocumentPanel
        onLoad={loadDocument}
        loading={loadingDoc}
        summary={docSummary}
      />
      <QAPanel
        onAsk={askQuestion}
        items={qaItems}
        asking={asking}
        docLoaded={docLoaded}
      />
      <DocPanel
        markdown={qaMarkdown}
        onRefresh={refreshDoc}
        onClear={clearDoc}
        refreshing={refreshing}
      />
    </div>
  );
}

// ---- Styles -----------------------------------------------------------------

const sectionStyle: React.CSSProperties = {
  marginBottom: 24,
  padding: 16,
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  background: "#fff",
};

const headingStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  margin: "0 0 4px",
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
  margin: "0 0 10px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: 8,
  fontSize: 14,
  outline: "none",
};

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 16px",
    borderRadius: 6,
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    background: disabled ? "#e5e7eb" : "#4f46e5",
    color: disabled ? "#9ca3af" : "#fff",
    fontWeight: 600,
    fontSize: 13,
    whiteSpace: "nowrap",
  };
}
