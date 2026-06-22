import React, { useEffect, useRef, useState } from "react";
import { createAgent } from "@palinc/nirnam/agents";
import type { NirnamAgent, RealLLMConfig } from "@palinc/nirnam/agents";

const SYSTEM_PROMPT = `You are a log event classifier for a production system.
Given a raw log entry, respond with a JSON object (and nothing else) in this shape:
{ "level": "info" | "warn" | "error" | "critical", "category": string, "summary": string }
Keep the summary under 20 words. Do not wrap the JSON in code fences.`;

const SAMPLE_LOGS = [
  `[2026-06-23T04:12:01Z] GET /api/users 200 42ms`,
  `[2026-06-23T04:12:09Z] Database connection pool exhausted — waiting for slot (timeout in 5s)`,
  `[2026-06-23T04:12:15Z] Unhandled exception in PaymentService.charge(): NullPointerException at line 88`,
  `[2026-06-23T04:12:22Z] Disk usage on /var/data reached 93% — threshold is 90%`,
  `[2026-06-23T04:12:34Z] User session expired for userId=4821 after 30 min of inactivity`,
  `[2026-06-23T04:12:41Z] CRITICAL: Redis primary unreachable — failover to replica initiated`,
];

interface Classification {
  level: "info" | "warn" | "error" | "critical";
  category: string;
  summary: string;
}

const LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  info:     { bg: "#dbeafe", text: "#1e3a8a" },
  warn:     { bg: "#fef3c7", text: "#78350f" },
  error:    { bg: "#fee2e2", text: "#7f1d1d" },
  critical: { bg: "#4c0519", text: "#fda4af" },
};

export default function MonitorTab({ llm }: { llm: RealLLMConfig }) {
  const agentRef = useRef<NirnamAgent | null>(null);
  const [results, setResults] = useState<Record<number, Classification | "loading" | "error">>({});

  useEffect(() => {
    // A passive agent: no public chat history, processes inputs in the background.
    agentRef.current = createAgent({
      llm,
      mode: "passive",
      systemPrompt: SYSTEM_PROMPT,
      autoCleanup: false,
    });
    return () => agentRef.current?.destroy();
  }, [llm]);

  const analyze = async (index: number) => {
    const agent = agentRef.current;
    if (!agent) return;
    setResults(r => ({ ...r, [index]: "loading" }));
    try {
      const raw = await agent.run(SAMPLE_LOGS[index]);
      const parsed = JSON.parse(raw) as Classification;
      setResults(r => ({ ...r, [index]: parsed }));
    } catch {
      setResults(r => ({ ...r, [index]: "error" }));
    }
  };

  const analyzeAll = () => {
    SAMPLE_LOGS.forEach((_, i) => analyze(i));
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>Passive Log Classifier</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            A <code>mode: "passive"</code> agent processes each log via <code>agent.run()</code> — no chat history, no UI.
          </div>
        </div>
        <button
          onClick={analyzeAll}
          style={{ background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}
        >
          Analyze All
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {SAMPLE_LOGS.map((entry, i) => {
          const result = results[i];
          const classification = result && result !== "loading" && result !== "error" ? result as Classification : null;
          const colors = classification ? LEVEL_COLORS[classification.level] : null;

          return (
            <div key={i} style={{
              border: "1px solid",
              borderColor: colors ? colors.text + "40" : "#e5e7eb",
              borderRadius: 8,
              overflow: "hidden",
              background: colors ? colors.bg : "#fff",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px" }}>
                <code style={{ fontSize: 11, color: "#374151", flex: 1 }}>{entry}</code>
                <button
                  onClick={() => analyze(i)}
                  disabled={result === "loading"}
                  style={{
                    marginLeft: 12,
                    background: colors ? colors.text : "#374151",
                    color: "#fff",
                    border: "none",
                    borderRadius: 4,
                    padding: "3px 10px",
                    fontSize: 11,
                    cursor: result === "loading" ? "not-allowed" : "pointer",
                    flexShrink: 0,
                    opacity: result === "loading" ? 0.6 : 1,
                  }}
                >
                  {result === "loading" ? "…" : "Analyze"}
                </button>
              </div>

              {result && result !== "loading" && (
                <div style={{ padding: "6px 12px 8px", borderTop: "1px solid " + (colors ? colors.text + "30" : "#e5e7eb") }}>
                  {result === "error"
                    ? <span style={{ fontSize: 12, color: "#dc2626" }}>Parse error — check LLM output format</span>
                    : (
                      <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12 }}>
                        <span style={{
                          background: colors!.text,
                          color: colors!.bg,
                          borderRadius: 4,
                          padding: "1px 8px",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          fontSize: 10,
                        }}>
                          {classification!.level}
                        </span>
                        <span style={{ fontWeight: 600, color: colors!.text }}>{classification!.category}</span>
                        <span style={{ color: "#6b7280" }}>{classification!.summary}</span>
                      </div>
                    )
                  }
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
