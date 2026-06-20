import React from "react";
import ScribeAgent from "./components/ScribeAgent";

export default function App() {
  return (
    <div style={{ fontFamily: "sans-serif", padding: 24 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>scribe-agent remote</h2>
      <ScribeAgent />
    </div>
  );
}
