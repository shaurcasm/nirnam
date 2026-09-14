/**
 * The transport workloads — the same five for every arm. Each returns a
 * flat metrics bag; the runner wraps it in the shared main-thread probes.
 *
 * - fan-out: N messages to M subscribers, the shape of a transcript line
 *   reaching every agent in a room.
 * - request-reply: K sequential round trips.
 * - stream: one stream of S chunks.
 * - worker → main: the arm's worker publishes N messages the page receives.
 * - worker round trip: K requests answered inside the worker.
 */

import type { Metrics } from '../harness/stats';
import { summarise } from '../harness/stats';
import { busyMeter } from '../harness/probes';
import { makePayload, type TransportArm } from './arm';

export interface TransportParams {
  messages: number;
  subscribers: number;
  requests: number;
  chunks: number;
}

export const DEFAULT_TRANSPORT_PARAMS: TransportParams = { messages: 2000, subscribers: 8, requests: 300, chunks: 500 };

export interface TransportWorkload {
  id: string;
  label: string;
  describe(params: TransportParams): string;
  /** `true`, or the reason this arm cannot run it. */
  supports(arm: TransportArm): true | string;
  run(arm: TransportArm, params: TransportParams): Promise<Metrics>;
}

/** A promise resolved by the handler that sees the last delivery — never a timer, which a hidden tab clamps to a second. */
function deliveries(target: number, timeoutMs = 30000) {
  let received = 0;
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => reject(new Error(`timed out: ${received} of ${target} delivered`)), timeoutMs);
  return {
    one() {
      received += 1;
      if (received >= target) {
        clearTimeout(timer);
        resolve();
      }
    },
    done,
  };
}

const fanout: TransportWorkload = {
  id: 'fanout',
  label: 'Fan-out',
  describe: p => `${p.messages.toLocaleString('en-US')} messages × ${p.subscribers} subscribers`,
  supports: () => true,
  async run(arm, { messages, subscribers }) {
    const topic = 'bench:transcript';
    const meter = busyMeter();
    const latencies: number[] = [];
    const delivered = deliveries(messages * subscribers);
    const offs = Array.from({ length: subscribers }, () =>
      arm.subscribe(topic, payload =>
        meter.measure(() => {
          latencies.push(performance.now() - (payload as { sentAt: number }).sentAt);
          delivered.one();
        }),
      ),
    );
    const start = performance.now();
    for (let seq = 0; seq < messages; seq++) {
      const payload = makePayload(seq);
      meter.measure(() => arm.publish(topic, payload));
    }
    await delivered.done;
    const wall = performance.now() - start;
    offs.forEach(off => off());
    const lat = summarise(latencies);
    return {
      wall,
      throughput: (messages * subscribers) / (wall / 1000),
      'lat.p50': lat.p50,
      'lat.p95': lat.p95,
      'lat.max': lat.max,
      busyMs: meter.total(),
      busyPer1k: (meter.total() / (messages * subscribers)) * 1000,
    };
  },
};

const requestReply: TransportWorkload = {
  id: 'request-reply',
  label: 'Request-reply',
  describe: p => `${p.requests} sequential round trips`,
  supports: arm => (arm.request && arm.handle ? true : 'no request-reply'),
  async run(arm, { requests }) {
    const off = arm.handle!('bench:rr', payload => payload);
    const latencies: number[] = [];
    const start = performance.now();
    for (let i = 0; i < requests; i++) {
      const before = performance.now();
      await arm.request!('bench:rr', makePayload(i));
      latencies.push(performance.now() - before);
    }
    const wall = performance.now() - start;
    off();
    const lat = summarise(latencies);
    return { wall, throughput: requests / (wall / 1000), 'lat.p50': lat.p50, 'lat.p95': lat.p95, 'lat.max': lat.max };
  },
};

const stream: TransportWorkload = {
  id: 'stream',
  label: 'Stream',
  describe: p => `one stream of ${p.chunks} chunks`,
  supports: arm => (arm.requestStream && arm.handleStream ? true : 'no streaming'),
  async run(arm, { chunks }) {
    const off = arm.handleStream!('bench:stream', async function* (payload) {
      const n = (payload as { n: number }).n;
      for (let i = 0; i < n; i++) yield { i, sentAt: performance.now(), text: 'token' };
    });
    const gaps: number[] = [];
    let last = performance.now();
    const start = last;
    let count = 0;
    for await (const _chunk of arm.requestStream!('bench:stream', { n: chunks })) {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      count += 1;
    }
    const wall = performance.now() - start;
    off();
    if (count !== chunks) throw new Error(`stream delivered ${count} of ${chunks}`);
    const gap = summarise(gaps);
    return { wall, throughput: chunks / (wall / 1000), 'gap.p50': gap.p50, 'gap.p95': gap.p95, 'gap.max': gap.max };
  },
};

const workerToMain: TransportWorkload = {
  id: 'worker-to-main',
  label: 'Worker → main',
  describe: p => `${p.messages.toLocaleString('en-US')} messages published from the worker`,
  supports: arm => (arm.workerPublish ? true : 'no worker reach'),
  async run(arm, { messages }) {
    const topic = 'bench:from-worker';
    const meter = busyMeter();
    const delivered = deliveries(messages);
    const off = arm.subscribe(topic, () => meter.measure(() => delivered.one()));
    const start = performance.now();
    await arm.workerPublish!(topic, messages);
    await delivered.done;
    const wall = performance.now() - start;
    off();
    return { wall, throughput: messages / (wall / 1000), busyMs: meter.total(), busyPer1k: (meter.total() / messages) * 1000 };
  },
};

const workerRoundTrip: TransportWorkload = {
  id: 'worker-round-trip',
  label: 'Main ↔ worker',
  describe: p => `${p.requests} sequential requests answered in the worker`,
  supports: arm => (arm.workerRequest ? true : 'no worker reach'),
  async run(arm, { requests }) {
    const latencies: number[] = [];
    const start = performance.now();
    for (let i = 0; i < requests; i++) {
      const before = performance.now();
      await arm.workerRequest!(makePayload(i));
      latencies.push(performance.now() - before);
    }
    const wall = performance.now() - start;
    const lat = summarise(latencies);
    return { wall, throughput: requests / (wall / 1000), 'lat.p50': lat.p50, 'lat.p95': lat.p95, 'lat.max': lat.max };
  },
};

export const TRANSPORT_WORKLOADS: TransportWorkload[] = [fanout, requestReply, stream, workerToMain, workerRoundTrip];
