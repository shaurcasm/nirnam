import { useState } from 'react';
import { measured, type Case } from '../harness/runner';
import { ResultsTable } from '../harness/ResultsTable';
import { useRunner } from '../harness/useRunner';
import { RunBar, ParamField } from '../ui';
import type { McpArm } from './arm';
import { inMemoryArm } from './arms/inMemory';
import { nirnamMainArm } from './arms/nirnamMain';
import { nirnamWorkerArm } from './arms/nirnamWorker';
import { rawPostMessageArm } from './arms/rawPostMessage';
import { DEFAULT_MCP_PARAMS, MCP_WORKLOADS, type McpParams } from './workloads';

const ARMS: Array<() => McpArm> = [inMemoryArm, rawPostMessageArm, nirnamMainArm, nirnamWorkerArm];

function buildCases(params: McpParams): Case[] {
  const cases: Case[] = [];
  for (const workload of MCP_WORKLOADS) {
    for (const make of ARMS) {
      const probe = make();
      cases.push({
        arm: probe.id,
        armLabel: probe.label,
        workload: workload.id,
        workloadLabel: `${workload.label} — ${workload.describe(params)}`,
        run: async () => {
          const arm = make();
          const client = await arm.setup();
          try {
            return await measured(() => workload.run(client, params));
          } finally {
            await arm.teardown();
          }
        },
      });
    }
  }
  return cases;
}

const NOTES: Record<string, string> = {
  echo: 'the transport alone: InMemory is the floor, Nirnam pays the hub hops, the worker arms pay a thread hop',
  analyse: 'the tool holds its thread: watch loop lag and fps — on the main-thread arms the page waits for every call, on the worker arms it does not',
  'analyse-concurrent': 'with calls in flight the main-thread arms serialise on the one thread they have; the worker arms leave main free while the worker queues',
};

export function McpTab() {
  const [params, setParams] = useState(DEFAULT_MCP_PARAMS);
  const { results, running, progress, start, abort } = useRunner('mcp');
  return (
    <section>
      <p className="muted" style={{ maxWidth: 820 }}>
        One MCP server with two tools — <code>echo</code>, which costs nothing, and <code>analyse</code>, which works for a few
        milliseconds — served four ways: the SDK's in-memory pair, a hand-rolled postMessage transport to a worker, and Nirnam's transport
        with the server on the main thread and in a worker. The client is the SDK's <code>Client</code> in every arm.
      </p>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <ParamField label="echo calls" value={params.calls} onChange={v => setParams({ ...params, calls: v })} />
        <ParamField label="analyse calls" value={params.heavyCalls} onChange={v => setParams({ ...params, heavyCalls: v })} />
        <ParamField label="tool ms" value={params.toolMs} onChange={v => setParams({ ...params, toolMs: v })} />
        <ParamField label="in flight" value={params.concurrency} onChange={v => setParams({ ...params, concurrency: v })} />
      </div>
      <RunBar running={running} progress={progress} onRun={() => start(buildCases(params))} onAbort={abort} />
      <ResultsTable results={results} notes={NOTES} />
    </section>
  );
}
