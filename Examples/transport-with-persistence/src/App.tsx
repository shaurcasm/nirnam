import React, { useCallback, useState } from "react";
import HostPanel from "./components/HostPanel";
import CartPanel from "./components/CartPanel";
import InventoryPanel from "./components/InventoryPanel";
import PersistencePanel from "./components/PersistencePanel";
import EventLog from "./components/EventLog";

export interface LogEntry {
  id: number;
  ts: number;
  service: string;
  color: string;
  kind: "pub" | "sub" | "req" | "res" | "stream" | "disc" | "replay";
  topic: string;
  data: string;
}

let seq = 0;
export type Log = (e: Omit<LogEntry, "id" | "ts">) => void;

export default function App() {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  const log = useCallback<Log>((e) => {
    setEntries(p => [...p.slice(-299), { ...e, id: seq++, ts: Date.now() }]);
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "20px 24px", maxWidth: 1400, margin: "0 auto" }}>
      <h1 style={{ margin: "0 0 4px" }}>Nirnam · Transport + Persistence</h1>
      <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 4px" }}>
        Extends the transport example with <strong>IndexedDB persistence</strong>.
        Alerts and orders published with <code>{`{ persist: true }`}</code> survive page reloads and reach
        late-joining subscribers via <code>{`{ replay: N }`}</code>.
      </p>
      <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 20, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span>💡 <strong>Try:</strong> publish some alerts → reload the page → Inventory still shows them</span>
        <span>💡 <strong>Try:</strong> open a second tab → click "Join Late" in the Persistence panel</span>
        <span>💡 DevTools → Application → IndexedDB → <code>nirnam-persistence-v1</code></span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
        <HostPanel log={log} />
        <CartPanel log={log} />
        <InventoryPanel log={log} />
      </div>

      <div style={{ marginBottom: 20 }}>
        <PersistencePanel log={log} />
      </div>

      <EventLog entries={entries} />
    </div>
  );
}
