import React, { useEffect, useState } from "react";
import { createBus } from "@palinc/nirnam";
import type { Log } from "../App";

// Independent bus — simulates the Inventory micro-frontend's own bus instance.
const bus = createBus();

interface StockItem {
  name: string;
  stock: number;
}

const INITIAL_STOCK: Record<string, StockItem> = {
  "sku-001": { name: "Mechanical Keyboard", stock: 12 },
  "sku-002": { name: "USB Hub", stock: 34 },
  "sku-003": { name: "Monitor Stand", stock: 7 },
};

export default function InventoryPanel({ log }: { log: Log }) {
  const [stock, setStock] = useState(INITIAL_STOCK);
  const [alerts, setAlerts] = useState<string[]>([]);

  useEffect(() => {
    bus.register({
      agentId: "inventory-service",
      capabilities: ["subscriber: order:placed", "subscriber: system:alert"],
    });

    // Reduce stock when an order is placed.
    const unsubOrder = bus.subscribe<{ orderId: string; items: { id: string; qty: number }[] }>(
      "order:placed",
      (order) => {
        log({ service: "Inv", color: "#b45309", kind: "sub", topic: "order:placed", data: `orderId=${order.orderId}` });
        setStock(prev => {
          const next = { ...prev };
          for (const item of order.items) {
            if (next[item.id]) {
              next[item.id] = {
                ...next[item.id],
                stock: Math.max(0, next[item.id].stock - item.qty),
              };
            }
          }
          return next;
        });
      },
    );

    // Display alerts broadcast by the host.
    const unsubAlert = bus.subscribe<{ message: string }>(
      "system:alert",
      (payload) => {
        log({ service: "Inv", color: "#b45309", kind: "sub", topic: "system:alert", data: payload.message });
        setAlerts(p => [...p.slice(-4), payload.message]);
      },
      { replay: 5 },
    );

    return () => {
      unsubOrder();
      unsubAlert();
      bus.close();
    };
  }, [log]);

  return (
    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 16 }}>
      <h3 style={{ margin: "0 0 2px", color: "#78350f" }}>📦 Inventory Service</h3>
      <code style={{ fontSize: 10, color: "#d97706" }}>subscribe · register</code>

      <div style={{ marginTop: 12 }}>
        {Object.entries(stock).map(([id, item]) => (
          <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginBottom: 6 }}>
            <span>{item.name}</span>
            <span style={{
              background: item.stock < 5 ? "#fee2e2" : "#d1fae5",
              color: item.stock < 5 ? "#991b1b" : "#065f46",
              borderRadius: 12,
              padding: "1px 8px",
              fontWeight: 600,
              fontSize: 11,
            }}>
              {item.stock} units {item.stock < 5 ? "⚠️" : ""}
            </span>
          </div>
        ))}
      </div>

      {alerts.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 4 }}>RECEIVED ALERTS</div>
          {alerts.map((a, i) => (
            <div key={i} style={{ fontSize: 11, background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 4, padding: "2px 6px", marginBottom: 2 }}>
              ⚠️ {a}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
