# Recorded runs

Every table names the machine, the browser and whether the tab was in front.
Default parameters unless stated. Values are the per-metric median of three
repetitions after one warm-up. Milliseconds unless marked.

## Run 1 — 2026-09-15, desktop, **tab in the background**

- Machine: Windows 11, Intel Core Ultra 9 275HX (24 logical cores), 32 GB, RTX 5080; DPR 1.25
- Browser: Chrome 153 (automation window, never in front)
- Library: `@palinc/nirnam` from `Library/` at commit `11a5507` (2.1.1 + `inlineWorker` + the `MCPBus` type fix)
- **Because the tab was hidden**, loop lag, fps and long-frame columns read 0 and are omitted; the canvas tab could not run. Wall, latency and busy-time columns are event-driven and unaffected. A visible-tab run of the same build goes below when recorded.

### Transport

Fan-out — 2,000 messages × 8 subscribers (16,000 deliveries)

| arm | Nirnam | wall | rate /s | latency p50 | p95 | max | main busy | busy / 1k |
|---|---|---|---|---|---|---|---|---|
| In-memory emitter | no | 10.2 | 1,568,627 | 0.00 | 0.00 | 0.30 | 15.1 | 0.94 |
| window CustomEvent | no | 15.2 | 1,052,632 | 0.00 | 0.00 | 0.30 | 19.0 | 1.19 |
| Raw postMessage worker | no | 18.1 | 883,978 | 9.30 | 13.6 | 14.0 | 8.50 | 0.53 |
| Nirnam · inline hub | yes | 15.9 | 1,006,289 | 0.00 | 0.00 | 0.20 | 20.3 | 1.27 |
| Nirnam · dedicated hub | yes | 31.6 | 506,329 | 16.3 | 19.0 | 19.1 | 16.9 | 1.06 |
| Nirnam · worker participant | yes | 30.3 | 528,053 | 14.7 | 17.2 | 17.4 | 16.2 | 1.01 |

Reading: with every participant on the main thread the emitter wins, as it
should — the dedicated hub pays two hops and two structured clones per
message, and a 2,000-message burst queues behind itself (that is the
~16 ms p50: the deliveries land after the publish loop, not during it).
Busy time on main is within a few ms of the emitter for every arm: the
routing happens elsewhere, but the handler still runs here.

Request-reply — 300 sequential round trips

| arm | Nirnam | wall | rate /s | latency p50 | p95 | max |
|---|---|---|---|---|---|---|
| In-memory emitter | no | 0.80 | 375,000 | 0.00 | 0.00 | 0.20 |
| window CustomEvent | no | 2.60 | 115,385 | 0.00 | 0.10 | 0.20 |
| Raw postMessage worker | no | 13.6 | 22,059 | 0.00 | 0.10 | 0.50 |
| Nirnam · inline hub | yes | 1.30 | 230,769 | 0.00 | 0.00 | 0.10 |
| Nirnam · dedicated hub | yes | 24.9 | 12,048 | 0.00 | 0.20 | 7.40 |
| Nirnam · worker participant | yes | 23.2 | 12,931 | 0.10 | 0.20 | 0.50 |

Stream — one stream of 500 chunks

| arm | Nirnam | wall | rate /s | chunk gap p50 | p95 |
|---|---|---|---|---|---|
| In-memory emitter | no | 0.20 | 2,499,999 | 0.00 | 0.00 |
| window CustomEvent | no | — no streaming | | | |
| Raw postMessage worker | no | — no streaming | | | |
| Nirnam · inline hub | yes | 1.60 | 312,500 | 0.00 | 0.00 |
| Nirnam · dedicated hub | yes | 11.3 | 44,248 | 0.00 | 0.00 |
| Nirnam · worker participant | yes | 5.10 | 98,039 | 0.00 | 0.10 |

Worker → main — 2,000 messages published from the worker

| arm | Nirnam | wall | rate /s | main busy | busy / 1k |
|---|---|---|---|---|---|
| Raw postMessage worker | no | 7.80 | 256,410 | 0.50 | 0.25 |
| Nirnam · worker participant | yes | 13.2 | 151,515 | 0.20 | 0.10 |
| every other arm | | — no worker reach | | | |

Reading: this is where the main thread is quiet — 0.2 ms busy for 2,000
deliveries, against ~16 ms for the same count fanned out from main. The
raw arm is faster on wall (one hop, no hub) and costs 145 lines to the
Nirnam arm's 61, for one worker, with no streaming, tabs or discovery.

Main ↔ worker — 300 sequential requests answered in the worker

| arm | Nirnam | wall | rate /s | latency p50 | p95 | max |
|---|---|---|---|---|---|---|
| Raw postMessage worker | no | 7.20 | 41,667 | 0.00 | 0.10 | 0.40 |
| Nirnam · worker participant | yes | 23.0 | 13,043 | 0.10 | 0.20 | 0.50 |

### MCP

echo — 300 sequential calls of a tool that does nothing

| arm | Nirnam | server on | wall | rate /s | latency p50 | p95 | max |
|---|---|---|---|---|---|---|---|
| SDK InMemoryTransport | no | main | 15.6 | 19,231 | 0.00 | 0.20 | 1.30 |
| Raw postMessage transport | no | worker | 30.1 | 9,967 | 0.10 | 0.30 | 2.40 |
| Nirnam transport · server on main | yes | main | 44.0 | 6,818 | 0.10 | 0.20 | 1.60 |
| Nirnam transport · server in a worker | yes | worker | 59.0 | 5,085 | 0.20 | 0.40 | 3.90 |

analyse — 40 sequential calls of a tool that works for 8 ms

| arm | Nirnam | server on | wall | latency p50 | p95 | max |
|---|---|---|---|---|---|---|
| SDK InMemoryTransport | no | main | 321.2 | 8.00 | 8.10 | 8.10 |
| Raw postMessage transport | no | worker | 332.7 | 8.20 | 8.50 | 10.3 |
| Nirnam transport · server on main | yes | main | 331.7 | 8.30 | 8.50 | 9.00 |
| Nirnam transport · server in a worker | yes | worker | 334.9 | 8.20 | 8.50 | 11.0 |

analyse ×8 in flight — 40 calls of the 8 ms tool

| arm | Nirnam | server on | wall | latency p50 | p95 | max |
|---|---|---|---|---|---|---|
| SDK InMemoryTransport | no | main | 322.3 | 64.4 | 64.9 | 65.1 |
| Raw postMessage transport | no | worker | 325.6 | 64.3 | 65.2 | 67.9 |
| Nirnam transport · server on main | yes | main | 322.5 | 64.5 | 64.7 | 64.7 |
| Nirnam transport · server in a worker | yes | worker | 326.8 | 64.4 | 65.3 | 68.7 |

Reading: on `analyse` every arm takes the same wall — 40 × 8 ms of work is
40 × 8 ms wherever it runs, and one worker serialises the concurrent calls
just as one main thread does. The transport's own overhead (0.1–0.4 ms a
call) vanishes against an 8 ms tool. What the table cannot show from a
hidden tab is the point of the worker arms: for those 320 ms the main
thread was free. In a visible tab, loop lag p95 on the main-thread arms
reads ≈ the tool's duration and on the worker arms ≈ 0; record that below.

### Canvas

Not runnable from a hidden tab. Record below.

### Effort (from the Effort tab, this build)

| use case | arm | app code lines |
|---|---|---|
| transport | In-memory emitter | 43 |
| transport | window CustomEvent | 51 |
| transport | Raw postMessage worker (+ its worker) | 145 |
| transport | Nirnam, inline or dedicated | 28 |
| transport | Nirnam worker participant (+ its worker) | 61 |
| transport | *library the Nirnam arms lean on* | 757 in 5 files |
| mcp | SDK InMemoryTransport | 28 |
| mcp | Raw postMessage transport (+ its worker) | 86 |
| mcp | Nirnam, server on main | 32 |
| mcp | Nirnam, server in a worker (+ its worker) | 38 |
| mcp | *library the Nirnam arms lean on* | `mcp.ts` |
| canvas | Nirnam runtime, both arms | `arms.ts` + `orchestrator.ts` + `bench.worker.ts` |
| canvas | *library the app would own without it* | host, orchestrator, layers, tier, inline, react binding |

The Effort tab has the exact counts and the feature matrix for the build you are running.

## Run 2 — visible tab (to record)

Same machine, tab in front. Fill in from `copy JSON`, all three tabs; the
canvas table needs `typing p50/p95`, `loop lag p95`, `main fps p5`,
`long frames`, `frames drawn`, `surface p95` per arm.
