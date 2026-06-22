import React, { useCallback, useEffect, useState } from "react";
import { createBus } from "@palinc/nirnam";
import type { AgentRegistration } from "@palinc/nirnam";
import type { Log } from "../App";

// Module-level bus — simulates the host MFE's own independent bus instance.
const bus = createBus();

export default function HostPanel({ log }: { log: Log }) {
  const [agents, setAgents] = useState<AgentRegistration[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [prices, setPrices] = useState<string[]>([]);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    const unsub = bus.onAgentChange((ev) => {
      log({ service: "Host", color: "#1d4ed8", kind: "disc", topic: "agent-registry", data: `${ev.type}: ${ev.agent.agentId}` });
      bus.discoverAgents().then(setAgents);
    });
    bus.discoverAgents().then(setAgents);
    return () => {
      unsub();
      bus.close();
    };
  }, [log]);

  const getTotal = useCallback(async () => {
    setBusy("total");
    setResult(null);
    log({ service: "Host", color: "#1d4ed8", kind: "req", topic: "cart:getTotal", data: "" });
    try {
      const total = await bus.request<void, number>("cart:getTotal", undefined, 3000);
      setResult(`Cart total: $${total}`);
      log({ service: "Host", color: "#1d4ed8", kind: "res", topic: "cart:getTotal", data: `$${total}` });
    } catch (e) {
      setResult(`Error: ${(e as Error).message}`);
    }
    setBusy("");
  }, [log]);

  const checkout = useCallback(async () => {
    setBusy("checkout");
    setResult(null);
    log({ service: "Host", color: "#1d4ed8", kind: "req", topic: "cart:checkout", data: '{ note: "rush" }' });
    try {
      const r = await bus.request<{ note: string }, { orderId: string; total: number }>(
        "cart:checkout", { note: "rush" }, 3000,
      );
      setResult(`Order placed: ${r.orderId} ($${r.total})`);
      log({ service: "Host", color: "#1d4ed8", kind: "res", topic: "cart:checkout", data: JSON.stringify(r) });
    } catch (e) {
      setResult(`Error: ${(e as Error).message}`);
    }
    setBusy("");
  }, [log]);

  const broadcastAlert = useCallback(() => {
    bus.publish("system:alert", { message: "Low stock warning — restock required" });
    log({ service: "Host", color: "#1d4ed8", kind: "pub", topic: "system:alert", data: "Low stock warning — restock required" });
  }, [log]);

  const streamPrices = useCallback(async () => {
    setPrices([]);
    setBusy("stream");
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
      <code style={{ fontSize: 10, color: "#3b82f6" }}>createBus() — requests · broadcasts · discovery</code>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
        <Btn color="#1d4ed8" onClick={getTotal} disabled={!!busy}>request → cart:getTotal</Btn>
        <Btn color="#1d4ed8" onClick={checkout} disabled={!!busy}>request → cart:checkout</Btn>
        <Btn color="#7c3aed" onClick={broadcastAlert} disabled={!!busy}>publish → system:alert</Btn>
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
  color: string;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: color,
        color: "#fff",
        border: "none",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        textAlign: "left",
      }}
    >
      {children}
    </button>
  );
}
