import React, { useEffect, useRef, useState } from "react";
import { createBus } from "@palinc/nirnam";
import type { Log } from "../App";

const bus = createBus();

interface StockItem { name: string; stock: number; }

const INITIAL_STOCK: Record<string, StockItem> = {
  "sku-001": { name: "Mechanical Keyboard", stock: 12 },
  "sku-002": { name: "USB Hub",             stock: 34 },
  "sku-003": { name: "Monitor Stand",       stock: 7  },
};

interface AlertEntry { message: string; replayed: boolean; }

export default function InventoryPanel({ log }: { log: Log }) {
  const [stock, setStock] = useState(INITIAL_STOCK);
  const [orderCount, setOrderCount] = useState(0);
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);

  // Track whether we're still in the initial replay window (first ~300ms after mount).
  const isReplayingRef = useRef(true);
  useEffect(() => {
    const t = setTimeout(() => { isReplayingRef.current = false; }, 300);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    bus.register({
      agentId: "inventory-service",
      capabilities: ["subscriber: order:placed", "subscriber: system:alert"],
    });

    // replay: 3 — on mount, immediately receive the last 3 persisted orders.
    const unsubOrder = bus.subscribe<{ orderId: string; items: { id: string; qty: number }[]; total: number }>(
      "order:placed",
      (order) => {
        const replayed = isReplayingRef.current;
        log({
          service: "Inv", color: "#b45309",
          kind: replayed ? "replay" : "sub",
          topic: "order:placed",
          data: `${replayed ? "[REPLAY] " : ""}orderId=${order.orderId}`,
        });
        setOrderCount(c => c + 1);
        setStock(prev => {
          const next = { ...prev };
          for (const item of order.items) {
            if (next[item.id]) {
              next[item.id] = { ...next[item.id], stock: Math.max(0, next[item.id].stock - item.qty) };
            }
          }
          return next;
        });
      },
      { replay: 3 },
    );

    // replay: 5 — on mount, immediately receive the last 5 persisted alerts.
    const unsubAlert = bus.subscribe<{ message: string }>(
      "system:alert",
      (payload) => {
        const replayed = isReplayingRef.current;
        log({
          service: "Inv", color: "#b45309",
          kind: replayed ? "replay" : "sub",
          topic: "system:alert",
          data: `${replayed ? "[REPLAY] " : ""}${payload.message}`,
        });
        setAlerts(p => [...p.slice(-4), { message: payload.message, replayed }]);
      },
      { replay: 5 },
    );

    return () => { unsubOrder(); unsubAlert(); bus.close(); };
  }, [log]);

  return (
    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 16 }}>
      <h3 style={{ margin: "0 0 2px", color: "#78350f" }}>📦 Inventory Service</h3>
      <code style={{ fontSize: 10, color: "#d97706" }}>subscribe(replay:5) · subscribe(replay:3)</code>

      <div style={{ marginTop: 12 }}>
        {Object.entries(stock).map(([id, item]) => (
          <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginBottom: 6 }}>
            <span>{item.name}</span>
            <span style={{
              background: item.stock < 5 ? "#fee2e2" : "#d1fae5",
              color: item.stock < 5 ? "#991b1b" : "#065f46",
              borderRadius: 12, padding: "1px 8px", fontWeight: 600, fontSize: 11,
            }}>
              {item.stock} units {item.stock < 5 ? "⚠️" : ""}
            </span>
          </div>
        ))}
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
          Orders replayed on mount: {orderCount}
        </div>
      </div>

      {alerts.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 4 }}>ALERTS</div>
          {alerts.map((a, i) => (
            <div key={i} style={{
              fontSize: 11,
              background: a.replayed ? "#fef9c3" : "#fef3c7",
              border: `1px solid ${a.replayed ? "#fde047" : "#fde68a"}`,
              borderRadius: 4, padding: "2px 6px", marginBottom: 2,
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6,
            }}>
              <span>⚠️ {a.message}</span>
              {a.replayed && (
                <span style={{
                  fontSize: 9, fontWeight: 700, background: "#fde047", color: "#713f12",
                  borderRadius: 3, padding: "1px 4px", flexShrink: 0,
                }}>
                  REPLAYED
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {alerts.length === 0 && (
        <div style={{ marginTop: 12, fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>
          Publish an alert then reload — it will reappear here tagged REPLAYED.
        </div>
      )}
    </div>
  );
}
