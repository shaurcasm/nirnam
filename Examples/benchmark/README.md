# benchmark — Nirnam with and without

One page, three use cases, the same workload on every arm: micro-frontend
transport, MCP, and off-main-thread canvas. Three tabs print numbers; the
fourth counts the source that produced them.

```bash
cd Examples/benchmark
npm install
npm run dev      # http://localhost:3400 — keep the tab in front
npm test         # the harness's arithmetic, in Node
```

Recorded runs are in [RESULTS.md](RESULTS.md).

## Read this first

Nirnam's *measurable* main-thread win is wherever work leaves the main
thread: the canvas runtime, and bus participants that live in workers. For
pub/sub between two main-thread modules, a hub hop — main → worker → main,
structured-cloned twice — is **not cheaper** than an in-memory emitter; it is
slower by a fraction of a millisecond, and the fan-out table shows that in
the first two rows. What Nirnam buys there is reach (workers, iframes, other
tabs), semantics (request-reply with timeouts, streaming, replay, discovery,
an MCP transport) and effort. Those are on the Effort tab, as lines and as a
feature matrix, not as milliseconds.

A benchmark that hid the losing arm would be marketing. This one keeps it.

## The tab must be visible

A hidden tab clamps timers to one a second and stops `requestAnimationFrame`.
Loop lag, fps and the whole canvas tab are meaningless in the background,
and the page says so in orange when it is. Wall, latency and busy-time
columns on the transport and MCP tabs are event-driven and survive it.

## Transport

Seven arms:

| arm | Nirnam | what it stands for |
|---|---|---|
| In-memory emitter | no | the singleton an MF host shares with its remotes; synchronous dispatch |
| window CustomEvent | no | what MFEs use when they must not import each other; request-reply hand-rolled |
| Raw postMessage worker | no | a hub written by hand for one worker: envelope, correlation ids, timeouts |
| Nirnam · inline hub | yes | the hub in this thread; zero hops |
| Nirnam · dedicated hub | yes | the default: hub in a Worker, two hops per message |
| Nirnam · shared hub | yes | the hub in a SharedWorker, every tab of the origin; falls back to dedicated where there is none and says so |
| Nirnam · worker participants | yes | dedicated hub + two workers on the bus via `adoptWorker` / `connectWorkerBus` |

Six workloads: fan-out (N messages × M subscribers), request-reply (K round
trips), stream (S chunks), worker → main (a worker publishes N), main ↔
worker (K requests answered in a worker), and worker → worker (one worker
publishes N, another receives them, the page hears one message at the end
— the main thread is not in the path, which only a bus gives you without
relaying every message yourself). An arm that cannot do a workload says why
in its row — that absence is a result.

Columns: `wall` (first publish to last delivery), `rate`, delivery `latency`
p50/p95/max (send timestamp to handler; sub-0.1 ms on synchronous arms is
timer resolution), `main busy` (time inside the publish calls and the
handlers — what the transport itself costs this thread; `/ 1k` per thousand
deliveries), and the shared probes below.

## MCP

One `McpServer` with two tools, `echo` (free) and `analyse` (holds its
thread for *tool ms*), served four ways; the client is the SDK's `Client`
every time:

| arm | Nirnam | server runs on |
|---|---|---|
| SDK InMemoryTransport | no | main — the floor, and the only place it can run |
| Raw postMessage transport | no | a worker, over two Transport classes written here |
| Nirnam transport · server on main | yes | main — the two-hop price without the thread move |
| Nirnam transport · server in a worker | yes | a worker — same client, server moved by address |

Workloads: `echo` ×K sequential, `analyse` ×K sequential, `analyse` ×K
with N in flight. On `analyse` the columns to read are loop lag and fps: the
main-thread arms stall the page for every call; the worker arms do not.

## Canvas

A surface shaped like Wevaad's trees without the art — six bitmaps painted
once, drawn every frame as swaying strips (`strips / frame` is the load;
Wevaad's tree pair is about 340) — on a dedicated worker, and the very same
surface and orchestrator on the main thread through `inlineWorker()`. Over
it, the benchmark types into a filtered list of 400 rows, one synthetic
keystroke every *n* ms, and measures each keystroke to the React commit it
caused. Both arms report `frames drawn`, `surface p95` and `over budget`
from the orchestrator's own stats so you can see the same work was done.

"look, without measuring" mounts an arm so you can type into the box
yourself and feel it; *repaint* triggers the bitmaps' rebuild, the expensive
one-off the trees pay on a route change (`rebuilds`, `rebuild ms`).

## The shared probes

Every run is wrapped in the same four, so the columns line up across tabs:

- **loop lag** p50/p95/max — a 25 ms timer chain; how late each tick fired
  is how long a click would have waited. The closest thing to INP that
  needs no real input.
- **main fps** median / p5 — the page's own `requestAnimationFrame` cadence;
  p5 is the slow tail (1000 / the 95th-percentile interval).
- **long frames** / **blocking** — `long-animation-frame` entries and their
  blocking time, the signal a vitals recorder reads.
- **keystroke→commit** (canvas only) — an INP proxy for a synthetic keystroke.

Each case runs once to warm up and then three times; tables show the
per-metric median, best value per column in green. `show JSON` / `copy JSON`
give the run with the machine's user agent; the same object is on
`window.__bench.<tab>` for scripts.

## Effort

Counted at build time from the files that ran (`?raw` imports), code lines
only. Each arm's own files sit next to the library source the Nirnam arms
lean on — the lines an app does not write, and the size of what it would
come to own once the plain arm needs the same reach. The feature matrix says
what each arm can do *as written here*; "hand-rolled" is a thing the arm had
to write to take part in a workload at all.

For the canvas there is no plain arm on purpose: the fair performance
control is the same runtime on the other thread. The effort comparison is
the library column — host, loop, tiers, stats — and the surface is the app's
either way.

## Caveats

- Chrome coarsens `performance.now()` to 0.1 ms; synchronous arms report
  latency at that floor.
- `main busy` counts only the time inside calls the harness wraps. Structured
  cloning of an outgoing `postMessage` is inside; the browser's own dispatch
  of an incoming task before the handler runs is not.
- Numbers are one machine, one browser, one build. Record what they came from.
