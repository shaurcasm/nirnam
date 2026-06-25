import React, { useCallback, useEffect, useRef, useState } from "react";
import { createBus } from "@palinc/nirnam";
import type { Log } from "../App";

interface ReplayedItem {
  topic: string;
  data: unknown;
  source: "replay" | "live";
  ts: number;
}

// How long after joining to consider incoming messages as "replayed" (IDB reads arrive
// well within this window; user-triggered publishes arrive after user interaction).
const REPLAY_WINDOW_MS = 300;

export default function PersistencePanel({ log }: { log: Log }) {
  const [state, setState] = useState<"idle" | "joined">("idle");
  const [items, setItems] = useState<ReplayedItem[]>([]);
  const busRef = useRef<ReturnType<typeof createBus> | null>(null);
  const replayDeadlineRef = useRef<number>(0);

  // Clean up late bus on unmount.
  useEffect(() => () => { busRef.current?.close(); }, []);

  const join = useCallback(() => {
    busRef.current?.close();
    const lateBus = createBus();
    busRef.current = lateBus;
    replayDeadlineRef.current = Date.now() + REPLAY_WINDOW_MS;
    setItems([]);
    setState("joined");

    const addItem = (topic: string, data: unknown) => {
      const source = Date.now() <= replayDeadlineRef.current ? "replay" : "live";
      setItems(p => [...p, { topic, data, source, ts: Date.now() }]);
      log({
        service: "Late", color: "#6d28d9",
        kind: source === "replay" ? "replay" : "sub",
        topic,
        data: `${source === "replay" ? "[REPLAY] " : ""}${JSON.stringify(data).slice(0, 60)}`,
      });
    };

    // Subscribe with replay — these deliver IDB history immediately, then stay live.
    lateBus.subscribe<{ message: string }>("system:alert", d => addItem("system:alert", d), { replay: 10 });
    lateBus.subscribe<unknown>("order:placed", d => addItem("order:placed", d), { replay: 5 });
  }, [log]);

  const reset = useCallback(() => {
    busRef.current?.close();
    busRef.current = null;
    setItems([]);
    setState("idle");
  }, []);

  const replayCount = items.filter(i => i.source === "replay").length;
  const liveCount   = items.filter(i => i.source === "live").length;

  return (
    <div style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 8, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: "0 0 2px", color: "#4c1d95" }}>🗄 Persistence Demo</h3>
          <code style={{ fontSize: 10, color: "#7c3aed" }}>Late subscriber · IDB replay · TTL eviction</code>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {state === "idle" ? (
            <ActionBtn color="#7c3aed" onClick={join}>Join as Late Subscriber</ActionBtn>
          ) : (
            <>
              <ActionBtn color="#6d28d9" onClick={join}>Rejoin</ActionBtn>
              <ActionBtn color="#6b7280" onClick={reset}>Disconnect</ActionBtn>
            </>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Message feed */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 6, display: "flex", gap: 10 }}>
            <span>MESSAGES RECEIVED</span>
            {state === "joined" && (
              <>
                <Badge color="#fde047" text={`${replayCount} replayed`} dark />
                <Badge color="#a7f3d0" text={`${liveCount} live`} />
              </>
            )}
          </div>

          {state === "idle" && (
            <div style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic" }}>
              Click "Join as Late Subscriber" to create a fresh bus that subscribes with{" "}
              <code>{`{ replay: N }`}</code> — it will instantly receive history from IndexedDB
              without anyone publishing again.
            </div>
          )}

          {state === "joined" && items.length === 0 && (
            <div style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic" }}>
              No persisted messages yet. Publish a system:alert or place an order first,
              then click Rejoin.
            </div>
          )}

          <div style={{ maxHeight: 160, overflowY: "auto" }}>
            {items.map((item, i) => (
              <div key={i} style={{
                fontSize: 11, borderRadius: 4, padding: "4px 8px", marginBottom: 3,
                background: item.source === "replay" ? "#fef9c3" : "#f0fdf4",
                border: `1px solid ${item.source === "replay" ? "#fde047" : "#bbf7d0"}`,
                display: "flex", gap: 6, alignItems: "flex-start",
              }}>
                <span style={{ flexShrink: 0 }}>
                  <Badge
                    color={item.source === "replay" ? "#fde047" : "#a7f3d0"}
                    text={item.source === "replay" ? "REPLAYED" : "LIVE"}
                    dark={item.source === "replay"}
                    small
                  />
                </span>
                <span style={{ color: "#7c3aed", fontWeight: 600, flexShrink: 0 }}>
                  {item.topic}
                </span>
                <span style={{ color: "#374151", wordBreak: "break-all" }}>
                  {JSON.stringify(item.data).slice(0, 80)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* How it works + tips */}
        <div style={{ fontSize: 11, color: "#6b7280", display: "flex", flexDirection: "column", gap: 10 }}>
          <Section title="How it works">
            <p style={{ margin: 0 }}>
              Messages published with <code style={{ color: "#7c3aed" }}>{`{ persist: true, ttl }`}</code> are written
              to <strong>IndexedDB</strong> with an expiry timestamp.
              Any subscriber with <code style={{ color: "#7c3aed" }}>{`{ replay: N }`}</code>
              immediately receives the last N non-expired records on mount — even after a page reload or in a second tab.
            </p>
          </Section>

          <Section title="What to try">
            <ol style={{ margin: 0, paddingLeft: 16, lineHeight: 1.8 }}>
              <li>Click "publish → system:alert" in the Host panel</li>
              <li>Click "Join as Late Subscriber" here → see REPLAYED badge</li>
              <li>Publish another alert → see LIVE badge arrive in real-time</li>
              <li><strong>Reload the page</strong> → Inventory still shows alerts (tagged REPLAYED)</li>
              <li>Open a second tab → same replay works cross-tab</li>
              <li>Wait for TTL to expire → messages stop appearing on rejoin</li>
            </ol>
          </Section>

          <Section title="Inspect IDB">
            <p style={{ margin: 0 }}>
              DevTools → Application → IndexedDB →{" "}
              <code style={{ color: "#7c3aed" }}>nirnam-persistence-v1</code> → <code>messages</code>
              <br />
              Each record has: <code>messageId</code>, <code>topic</code>, <code>payload</code>,
              <code> timestamp</code>, <code>expiresAt</code>, <code>seq</code>.
              Expired records are pruned automatically on next write.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Badge({ color, text, dark = false, small = false }: { color: string; text: string; dark?: boolean; small?: boolean }) {
  return (
    <span style={{
      background: color,
      color: dark ? "#713f12" : "#065f46",
      borderRadius: 3,
      padding: small ? "1px 4px" : "1px 6px",
      fontSize: small ? 9 : 10,
      fontWeight: 700,
    }}>
      {text}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", marginBottom: 3, textTransform: "uppercase" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function ActionBtn({ color, onClick, children }: { color: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      background: color, color: "#fff", border: "none", borderRadius: 6,
      padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 500,
    }}>
      {children}
    </button>
  );
}
