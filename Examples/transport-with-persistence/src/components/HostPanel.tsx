import React, { useCallback, useEffect, useState } from "react";
import { createBus } from "@palinc/nirnam";
import type { AgentRegistration } from "@palinc/nirnam";
import type { Log } from "../App";

const bus = createBus();

const TTL_OPTIONS = [
  { label: "30 s",  ms: 30_000 },
  { label: "2 min", ms: 120_000 },
  { label: "5 min", ms: 300_000 },
];

export default function HostPanel({ log }: { log: Log }) {
  const [agents, setAgents] = useState<AgentRegistration[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [prices, setPrices] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [ttlMs, setTtlMs] = useState(120_000);

  useEffect(() => {
    const unsub = bus.onAgentChange((ev) => {
      log({ service: "Host", color: "#1d4ed8", kind: "disc", topic: "agent-registry", data: `${ev.type}: ${ev.agent.agentId}` });
      bus.discoverAgents().then(setAgents);
    });
    bus.discoverAgents().then(setAgents);
    return () => { unsub(); bus.close(); };
  }, [log]);

  const getTotal = useCallback(async () => {
    setBusy("total"); setResult(null);
    log({ service: "Host", color: "#1d4ed8", kind: "req", topic: "cart:getTotal", data: "" });
    try {
      const total = await bus.request<void, number>("cart:getTotal", undefined, 3000);
      setResult(`Cart total: $${total}`);
      log({ service: "Host", color: "#1d4ed8", kind: "res", topic: "cart:getTotal", data: `$${total}` });
    } catch (e) { setResult(`Error: ${(e as Error).message}`); }
    setBusy("");
  }, [log]);

  const checkout = useCallback(async () => {
    setBusy("checkout"); setResult(null);
    log({ service: "Host", color: "#1d4ed8", kind: "req", topic: "cart:checkout", data: '{ note: "rush" }' });
    try {
      const r = await bus.request<{ note: string }, { orderId: string; total: number }>(
        "cart:checkout", { note: "rush" }, 3000,
      );
      setResult(`Order placed: ${r.orderId} ($${r.total})`);
      log({ service: "Host", color: "#1d4ed8", kind: "res", topic: "cart:checkout", data: JSON.stringify(r) });
    } catch (e) { setResult(`Error: ${(e as Error).message}`); }
    setBusy("");
  }, [log]);

  // Publish with { persist: true } so this alert survives reloads and reaches late subscribers.
  const broadcastAlert = useCallback(() => {
    const message = "Low stock warning — restock required";
    bus.publish("system:alert", { message }, { persist: true, ttl: ttlMs });
    log({
      service: "Host", color: "#1d4ed8", kind: "pub", topic: "system:alert",
      data: `${message} (persist, ttl=${ttlMs / 1000}s)`,
    });
  }, [log, ttlMs]);

  const streamPrices = useCallback(async () => {
    setPrices([]); setBusy("stream");
    log({ service: "Host", color: "#1d4ed8", kind: "stream", topic: "cart:priceStream", data: "starting…" });
    try {
      for await (const chunk of bus.requestStream<void, string>("cart:priceStream", undefined)) {
        setPrices(p => [...p, chunk]);
        log({ service: "Host", color: "#1d4ed8", kind: "stream", topic: "cart:priceStream", data: chunk });
      }
    } catch (e) {
      log({ service: "Host", color: "#1d4ed8", kind: "stream", topic: "cart:priceStream", data: `ERROR: ${(e as Error).message}` });
    }
    setBusy("");
  }, [log]);

  return (
    <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: 16 }}>
      <h3 style={{ margin: "0 0 2px", color: "#1e3a8a" }}>🖥 Host Dashboard</h3>
      <code style={{ fontSize: 10, color: "#3b82f6" }}>requests · broadcasts · persist:true</code>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
        <Btn color="#1d4ed8" onClick={getTotal} disabled={!!busy}>request → cart:getTotal</Btn>
        <Btn color="#1d4ed8" onClick={checkout} disabled={!!busy}>request → cart:checkout</Btn>

        {/* TTL selector + persist publish */}
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button
            onClick={broadcastAlert}
            disabled={!!busy}
            style={{
              flex: 1, background: "#7c3aed", color: "#fff", border: "none",
              borderRadius: 6, padding: "6px 10px", fontSize: 12,
              cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1, textAlign: "left",
            }}
          >
            publish → system:alert <span style={{ opacity: 0.8 }}>(persist ✓)</span>
          </button>
          <select
            value={ttlMs}
            onChange={e => setTtlMs(Number(e.target.value))}
            style={{ fontSize: 11, borderRadius: 4, border: "1px solid #c4b5fd", padding: "4px 6px", background: "#faf5ff" }}
          >
            {TTL_OPTIONS.map(o => (
              <option key={o.ms} value={o.ms}>TTL {o.label}</option>
            ))}
          </select>
        </div>

        <Btn color="#059669" onClick={streamPrices} disabled={!!busy}>
          {busy === "stream" ? "streaming…" : "requestStream → cart:priceStream"}
        </Btn>
      </div>

      {result && (
        <div style={{ marginTop: 8, fontSize: 12, background: "#dbeafe", borderRadius: 4, padding: "4px 8px" }}>
          {result}
        </div>
      )}
      {prices.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 4, padding: "4px 8px" }}>
          {prices.map((p, i) => <div key={i}>{p}</div>)}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 4 }}>REGISTERED SERVICES</div>
        {agents.length === 0
          ? <div style={{ fontSize: 11, color: "#9ca3af" }}>Waiting for registrations…</div>
          : agents.map(a => (
            <div key={a.agentId} style={{ fontSize: 11, background: "#dbeafe", borderRadius: 4, padding: "2px 6px", marginBottom: 2 }}>
              <strong>{a.agentId}</strong>
              {a.capabilities?.length ? `: ${a.capabilities.join(", ")}` : ""}
            </div>
          ))
        }
      </div>
    </div>
  );
}

function Btn({ color, onClick, disabled, children }: {
  color: string; onClick: () => void; disabled: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: color, color: "#fff", border: "none", borderRadius: 6,
      padding: "6px 10px", fontSize: 12, cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.6 : 1, textAlign: "left", width: "100%",
    }}>
      {children}
    </button>
  );
}
