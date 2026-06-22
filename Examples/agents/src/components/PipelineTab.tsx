import React, { useEffect, useRef, useState } from "react";
import { createAgent, connectAgents, pipelinePublish } from "@palinc/nirnam/agents";
import type { NirnamAgent, RealLLMConfig } from "@palinc/nirnam/agents";
import { createBus } from "@palinc/nirnam";
import type { NirnamBus } from "@palinc/nirnam";

const PIPELINE_TOPIC = "demo-pipeline";

const SUMMARIZER_PROMPT = `You are a concise summarizer.
Given a block of text, compress it into 2–3 clear sentences that capture the key points.
Output only the summary — no labels, no preamble.`;

const PLANNER_PROMPT = `You are an action-item extractor.
Given a summary of a situation or document, produce 3–5 concrete action items as a numbered list.
Each item should be specific and actionable. Output only the list.`;

const SAMPLE_TEXTS = [
  `The quarterly engineering review highlighted three main areas of concern: build times have increased
by 40% since the monorepo migration, the new observability stack is not yet integrated into CI,
and two senior engineers are leaving next month. On the positive side, the new API gateway reduced
latency by 28% and the mobile team shipped their first shared component library.`,
  `Customer support tickets for the checkout flow have risen 60% this week. Root cause analysis
identified three bugs: (1) the coupon code field clears on mobile after keyboard dismiss,
(2) the order confirmation email is delayed by up to 2 hours for international users,
(3) saved addresses are not pre-filled for returning users on Safari. The team has verified
fixes locally but they are pending code review and QA sign-off before deployment.`,
];

export default function PipelineTab({ llm }: { llm: RealLLMConfig }) {
  const busRef = useRef<NirnamBus | null>(null);
  const summarizerRef = useRef<NirnamAgent | null>(null);
  const plannerRef = useRef<NirnamAgent | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  const [input, setInput] = useState(SAMPLE_TEXTS[0]);
  const [summary, setSummary] = useState<string | null>(null);
  const [actionItems, setActionItems] = useState<string | null>(null);
  const [stage, setStage] = useState<"idle" | "summarizing" | "planning" | "done">("idle");

  useEffect(() => {
    // Both agents share one bus so connectAgents can route messages between them.
    const sharedBus = createBus();
    busRef.current = sharedBus;

    const summarizer = createAgent({
      llm,
      bus: sharedBus,
      systemPrompt: SUMMARIZER_PROMPT,
      autoCleanup: false,
    });
    const planner = createAgent({
      llm,
      bus: sharedBus,
      systemPrompt: PLANNER_PROMPT,
      autoCleanup: false,
    });
    summarizerRef.current = summarizer;
    plannerRef.current = planner;

    // Wire: summarizer → planner via the Nirnam bus.
    // The source agent publishes to nirnam:pipeline:{topic}:0;
    // the planner subscribes, runs, and its output is the final result.
    teardownRef.current = connectAgents([summarizer, planner], {
      topology: "pipeline",
      topic: PIPELINE_TOPIC,
    });

    return () => {
      teardownRef.current?.();
      summarizer.destroy();
      planner.destroy();
      sharedBus.close();
    };
  }, [llm]);

  const runPipeline = async () => {
    const summarizer = summarizerRef.current;
    const planner = plannerRef.current;
    if (!summarizer || !planner || stage !== "idle") return;

    setSummary(null);
    setActionItems(null);

    // Stage 1: summarize the input.
    setStage("summarizing");
    const summaryText = await summarizer.run(input);
    setSummary(summaryText);

    // Stage 2: extract action items from the summary.
    // In a reactive setup, connectAgents handles this automatically via the bus.
    // Here we also show the direct .run() call for clarity.
    setStage("planning");
    const items = await planner.run(summaryText);
    setActionItems(items);
    setStage("done");
  };

  const reset = () => {
    setSummary(null);
    setActionItems(null);
    setStage("idle");
  };

  const busy = stage === "summarizing" || stage === "planning";

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>Two-Agent Pipeline</div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
          <strong>Summarizer</strong> → <strong>Action Planner</strong>, connected via{" "}
          <code>connectAgents([], {"{ topology: 'pipeline', topic }"})</code> on a shared bus.
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 4 }}>
          SAMPLE INPUTS
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {SAMPLE_TEXTS.map((t, i) => (
            <button
              key={i}
              onClick={() => { setInput(t); reset(); }}
              style={{ fontSize: 11, background: input === t ? "#e0e7ff" : "#f3f4f6", border: "1px solid", borderColor: input === t ? "#818cf8" : "#e5e7eb", borderRadius: 4, padding: "3px 10px", cursor: "pointer" }}
            >
              Sample {i + 1}
            </button>
          ))}
        </div>
        <textarea
          value={input}
          onChange={e => { setInput(e.target.value); reset(); }}
          rows={5}
          style={{ width: "100%", boxSizing: "border-box", border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 13, resize: "vertical", fontFamily: "inherit" }}
        />
      </div>

      <button
        onClick={runPipeline}
        disabled={busy || !input.trim()}
        style={{
          background: busy ? "#6b7280" : "#1d4ed8",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "8px 20px",
          fontSize: 13,
          fontWeight: 600,
          cursor: busy ? "not-allowed" : "pointer",
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {busy ? `${stage === "summarizing" ? "Step 1: Summarizing…" : "Step 2: Planning…"}` : "▶ Run Pipeline"}
      </button>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <StageCard
          step={1}
          title="Summarizer"
          subtitle="Condenses input to 2–3 sentences"
          active={stage === "summarizing"}
          content={summary}
          color="#7c3aed"
        />
        <StageCard
          step={2}
          title="Action Planner"
          subtitle="Extracts 3–5 actionable items"
          active={stage === "planning"}
          content={actionItems}
          color="#059669"
          disabled={!summary}
        />
      </div>

      <div style={{ marginTop: 16, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
        <strong style={{ fontSize: 11, color: "#6b7280" }}>HOW CONNECTAGENTS WIRES THIS</strong>
        <pre style={{ margin: "6px 0 0", fontSize: 11, color: "#374151", overflowX: "auto" }}>{`connectAgents([summarizer, planner], {
  topology: 'pipeline',
  topic: 'demo-pipeline',
});

// Kick off the chain reactively (bus-driven):
pipelinePublish(summarizer, 'demo-pipeline', inputText);
// planner auto-receives summarizer output via the SharedWorker.`}</pre>
      </div>
    </div>
  );
}

function StageCard({ step, title, subtitle, active, content, color, disabled }: {
  step: number;
  title: string;
  subtitle: string;
  active: boolean;
  content: string | null;
  color: string;
  disabled?: boolean;
}) {
  return (
    <div style={{
      border: "1px solid",
      borderColor: active ? color : "#e5e7eb",
      borderRadius: 8,
      overflow: "hidden",
      opacity: disabled ? 0.5 : 1,
      transition: "border-color 0.2s",
    }}>
      <div style={{
        background: active ? color : "#f9fafb",
        color: active ? "#fff" : "#374151",
        padding: "8px 12px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        transition: "background 0.2s",
      }}>
        <span style={{ fontWeight: 700, fontSize: 12 }}>Step {step}</span>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 10, opacity: 0.75 }}>{subtitle}</div>
        </div>
        {active && <span style={{ marginLeft: "auto", fontSize: 12 }}>⟳</span>}
      </div>
      <div style={{ padding: "10px 12px", minHeight: 80, fontSize: 13, color: "#374151", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
        {content ?? <span style={{ color: "#9ca3af" }}>Waiting…</span>}
      </div>
    </div>
  );
}
