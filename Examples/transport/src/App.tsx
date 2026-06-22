import React, { useCallback, useState } from "react";
import HostPanel from "./components/HostPanel";
import CartPanel from "./components/CartPanel";
import InventoryPanel from "./components/InventoryPanel";
import EventLog from "./components/EventLog";

export interface LogEntry {
  id: number;
  ts: number;
  service: string;
  color: string;
  kind: "pub" | "sub" | "req" | "res" | "stream" | "disc";
  topic: string;
  data: string;
}

let seq = 0;
export type Log = (e: Omit<LogEntry, "id" | "ts">) => void;

export default function App() {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  const log = useCallback<Log>((e) => {
    setEntries(p => [...p.slice(-199), { ...e, id: seq++, ts: Date.now() }]);
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "20px 24px", maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ margin: "0 0 4px" }}>Nirnam · Transport Layer</h1>
      <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 20px" }}>
        Three independent <code>createBus()</code> instances — one per panel — communicate via the
        Nirnam SharedWorker without sharing any module-level state between services.
        Use the Host panel to trigger requests and broadcasts; watch them route through the worker.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
        <HostPanel log={log} />
        <CartPanel log={log} />
        <InventoryPanel log={log} />
      </div>
      <EventLog entries={entries} />
    </div>
  );
}
