import React, { useEffect, useRef, useState } from "react";
import { createBus } from "@palinc/nirnam";
import type { Log } from "../App";

const bus = createBus();

const INITIAL_ITEMS = [
  { id: "sku-001", name: "Mechanical Keyboard", qty: 1, price: 89 },
  { id: "sku-002", name: "USB Hub",             qty: 2, price: 29 },
  { id: "sku-003", name: "Monitor Stand",        qty: 1, price: 45 },
];

// order:placed is persisted so Inventory can replay order history after a reload.
const ORDER_TTL = 300_000; // 5 minutes

export default function CartPanel({ log }: { log: Log }) {
  const [items, setItems] = useState(INITIAL_ITEMS);
  const [orderCount, setOrderCount] = useState(0);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const totalRef = useRef(total);
  totalRef.current = total;

  useEffect(() => {
    bus.register({
      agentId: "cart-service",
      capabilities: ["cart:getTotal", "cart:checkout", "cart:priceStream"],
    });

    const unsubTotal = bus.handle<void, number>("cart:getTotal", () => {
      const t = totalRef.current;
      log({ service: "Cart", color: "#15803d", kind: "res", topic: "cart:getTotal", data: `$${t}` });
      return t;
    });

    const unsubCheckout = bus.handle<{ note?: string }, { orderId: string; total: number }>(
      "cart:checkout",
      (payload) => {
        const orderId = `ORD-${Date.now().toString(36).toUpperCase()}`;
        const t = totalRef.current;
        log({ service: "Cart", color: "#15803d", kind: "res", topic: "cart:checkout", data: orderId });

        // Persist so late subscribers can see order history after reload.
        bus.publish(
          "order:placed",
          { orderId, items: itemsRef.current, total: t, note: payload?.note },
          { persist: true, ttl: ORDER_TTL },
        );
        log({
          service: "Cart", color: "#15803d", kind: "pub", topic: "order:placed",
          data: `${orderId} (persist, ttl=5min)`,
        });

        setItems(INITIAL_ITEMS);
        setOrderCount(c => c + 1);
        return { orderId, total: t };
      },
    );

    const unsubStream = bus.handleStream<void, string>("cart:priceStream", async function* () {
      for (const item of itemsRef.current) {
        const chunk = `${item.name}: $${item.price}`;
        log({ service: "Cart", color: "#15803d", kind: "stream", topic: "cart:priceStream", data: chunk });
        yield chunk;
        await new Promise(r => setTimeout(r, 400));
      }
    });

    return () => { unsubTotal(); unsubCheckout(); unsubStream(); bus.close(); };
  }, [log]);

  return (
    <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 16 }}>
      <h3 style={{ margin: "0 0 2px", color: "#14532d" }}>🛒 Cart Service</h3>
      <code style={{ fontSize: 10, color: "#16a34a" }}>handle · handleStream · publish(order:placed, persist ✓)</code>

      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginTop: 12, marginBottom: 8 }}>
        <thead>
          <tr style={{ color: "#6b7280" }}>
            <th style={{ textAlign: "left", fontWeight: 500 }}>Item</th>
            <th style={{ textAlign: "right", fontWeight: 500 }}>Qty</th>
            <th style={{ textAlign: "right", fontWeight: 500 }}>$</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0
            ? (
              <tr>
                <td colSpan={3} style={{ color: "#9ca3af", fontStyle: "italic", paddingTop: 6 }}>
                  Cart cleared — awaiting next session
                </td>
              </tr>
            )
            : items.map(item => (
              <tr key={item.id}>
                <td style={{ paddingBottom: 2 }}>{item.name}</td>
                <td style={{ textAlign: "right" }}>×{item.qty}</td>
                <td style={{ textAlign: "right" }}>${item.price}</td>
              </tr>
            ))
          }
        </tbody>
      </table>

      <div style={{ borderTop: "1px solid #bbf7d0", paddingTop: 6, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span style={{ color: "#6b7280" }}>Orders processed: {orderCount}</span>
        <strong>Total: ${total}</strong>
      </div>
    </div>
  );
}
