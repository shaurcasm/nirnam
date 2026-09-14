import { useState } from 'react';
import { measured, type Case } from '../harness/runner';
import { ResultsTable } from '../harness/ResultsTable';
import { useRunner } from '../harness/useRunner';
import { RunBar, ParamField } from '../ui';
import type { TransportArm } from './arm';
import { emitterArm } from './arms/emitter';
import { customEventArm } from './arms/customEvent';
import { nirnamArm } from './arms/nirnam';
import { nirnamWorkerArm } from './arms/nirnamWorker';
import { rawPostMessageArm } from './arms/rawPostMessage';
import { DEFAULT_TRANSPORT_PARAMS, TRANSPORT_WORKLOADS, type TransportParams } from './workloads';

const ARMS: Array<() => TransportArm> = [emitterArm, customEventArm, rawPostMessageArm, () => nirnamArm('inline'), () => nirnamArm('dedicated'), nirnamWorkerArm];

function buildCases(params: TransportParams): Case[] {
  const cases: Case[] = [];
  for (const workload of TRANSPORT_WORKLOADS) {
    for (const make of ARMS) {
      const probe = make();
      const support = workload.supports(probe);
      const base = { arm: probe.id, armLabel: probe.label, workload: workload.id, workloadLabel: `${workload.label} — ${workload.describe(params)}` };
      if (support !== true) {
        cases.push({ ...base, unsupported: support });
        continue;
      }
      cases.push({
        ...base,
        run: async () => {
          const arm = make();
          await arm.setup();
          try {
            return await measured(() => workload.run(arm, params));
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
  fanout: 'every participant on the main thread: the emitter wins on latency and busy time, and should — this is the arm Nirnam pays two hops for',
  'request-reply': 'the emitter and CustomEvent arms had to write their request-reply to be here at all',
  stream: 'only arms with streaming',
  'worker-to-main': 'the worker publishes; the main thread pays for its subscriber and nothing else — compare busy time with fan-out',
  'worker-round-trip': 'same traffic pattern for both arms that can do it; the difference is in the effort tab',
};

export function TransportTab() {
  const [params, setParams] = useState(DEFAULT_TRANSPORT_PARAMS);
  const { results, running, progress, start, abort } = useRunner('transport');
  return (
    <section>
      <p className="muted" style={{ maxWidth: 820 }}>
        Six arms, five workloads. Three arms have no Nirnam in them. Where an arm cannot run a workload the row says why — that absence is a
        result too. Every run is warmed up once and repeated three times; the table is the median.
      </p>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <ParamField label="messages" value={params.messages} onChange={v => setParams({ ...params, messages: v })} />
        <ParamField label="subscribers" value={params.subscribers} onChange={v => setParams({ ...params, subscribers: v })} />
        <ParamField label="requests" value={params.requests} onChange={v => setParams({ ...params, requests: v })} />
        <ParamField label="chunks" value={params.chunks} onChange={v => setParams({ ...params, chunks: v })} />
      </div>
      <RunBar running={running} progress={progress} onRun={() => start(buildCases(params))} onAbort={abort} />
      <ResultsTable results={results} notes={NOTES} />
    </section>
  );
}
