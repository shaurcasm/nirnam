import React, { useEffect, useRef } from "react";
import type { LogEntry } from "../App";

const KIND_COLORS: Record<string, string> = {
  pub:    "#7c3aed",
  sub:    "#b45309",
  req:    "#1d4ed8",
  res:    "#0369a1",
  stream: "#059669",
  disc:   "#6b7280",
};

const KIND_LABEL: Record<string, string> = {
  pub:    "PUBLISH  ",
  sub:    "SUBSCRIBE",
  req:    "REQUEST  ",
  res:    "RESPONSE ",
  stream: "STREAM   ",
  disc:   "DISCOVERY",
};

export default function EventLog({ entries }: { entries: LogEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
      <div style={{
        background: "#f9fafb",
        borderBottom: "1px solid #e5e7eb",
        padding: "8px 16px",
        fontSize: 12,
        fontWeight: 600,
        color: "#6b7280",
        display: "flex",
        justifyContent: "space-between",
      }}>
        <span>EVENT LOG</span>
        <span style={{ fontWeight: 400 }}>{entries.length} events</span>
      </div>
      <div style={{
        height: 240,
        overflowY: "auto",
        background: "#0f172a",
        padding: "8px 14px",
        fontFamily: "monospace",
        fontSize: 11,
      }}>
        {entries.length === 0 && (
          <div style={{ color: "#475569" }}>Use the panels above to generate events…</div>
        )}
        {entries.map(e => (
          <div key={e.id} style={{ display: "flex", gap: 8, marginBottom: 2, alignItems: "baseline" }}>
            <span style={{ color: "#475569", flexShrink: 0 }}>
              {new Date(e.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <span style={{ color: e.color, fontWeight: 700, flexShrink: 0, minWidth: 30 }}>{e.service}</span>
            <span style={{ color: KIND_COLORS[e.kind] ?? "#fff", flexShrink: 0, minWidth: 76 }}>
              {KIND_LABEL[e.kind] ?? e.kind}
            </span>
            <span style={{ color: "#e2e8f0" }}>{e.topic}</span>
            {e.data && <span style={{ color: "#64748b" }}>→ {e.data}</span>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
