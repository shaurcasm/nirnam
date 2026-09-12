/**
 * The generated worker script, run for real.
 *
 * Every other suite mocks `src/worker-source`. This one evaluates the actual
 * bundled string inside a fake worker global scope, so the entry's two wiring
 * paths — SharedWorker `onconnect` and dedicated-worker `connect` messages —
 * are exercised as shipped. It also fails if the committed bundle is stale.
 */

import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import workerSource from '../src/worker-source';

interface FakePort {
  onmessage: ((event: { data: unknown; ports: FakePort[] }) => void) | null;
  postMessage: jest.Mock;
  start: jest.Mock;
  addEventListener: jest.Mock;
}

function fakePort(): FakePort {
  return { onmessage: null, postMessage: jest.fn(), start: jest.fn(), addEventListener: jest.fn() };
}

interface FakeScope {
  onconnect?: ((event: { ports: FakePort[] }) => void) | null;
  onmessage?: ((event: { data: unknown; ports: FakePort[] }) => void) | null;
}

function runWorker(scope: FakeScope): FakeScope {
  runInNewContext(workerSource, { self: scope });
  return scope;
}

/** Subscribe `a` and `b`, publish from `a`, expect both to receive. */
function assertRoutes(a: FakePort, b: FakePort) {
  a.onmessage?.({ data: { type: 'subscribe', topic: 't' }, ports: [] });
  b.onmessage?.({ data: { type: 'subscribe', topic: 't' }, ports: [] });
  a.onmessage?.({ data: { type: 'broadcast', topic: 't', payload: 'hi', sourcePageId: 'p' }, ports: [] });

  const expected = { type: 'broadcast', topic: 't', payload: 'hi', sourcePageId: 'p' };
  expect(a.postMessage).toHaveBeenCalledWith(expected);
  expect(b.postMessage).toHaveBeenCalledWith(expected);
}

describe('worker-source', () => {
  it('as a SharedWorker, routes between ports arriving on onconnect', () => {
    const scope = runWorker({ onconnect: null });
    expect(scope.onconnect).toEqual(expect.any(Function));
    expect(scope.onmessage).toBeUndefined();

    const a = fakePort();
    const b = fakePort();
    scope.onconnect!({ ports: [a] });
    scope.onconnect!({ ports: [b] });

    expect(a.start).toHaveBeenCalled();
    assertRoutes(a, b);
  });

  it('as a dedicated Worker, routes between ports transferred in connect messages', () => {
    const scope = runWorker({});
    expect(scope.onmessage).toEqual(expect.any(Function));
    expect(scope.onconnect).toBeUndefined();

    const a = fakePort();
    const b = fakePort();
    scope.onmessage!({ data: { type: 'connect' }, ports: [a] });
    scope.onmessage!({ data: { type: 'connect' }, ports: [b] });
    scope.onmessage!({ data: { type: 'subscribe', topic: 'ignored' }, ports: [] }); // not a connect: dropped

    assertRoutes(a, b);
  });

  it('ignores onconnect and connect events that carry no port', () => {
    const shared = runWorker({ onconnect: null });
    expect(() => shared.onconnect!({ ports: [] })).not.toThrow();

    const dedicated = runWorker({});
    expect(() => dedicated.onmessage!({ data: { type: 'connect' }, ports: [] })).not.toThrow();
  });

  it('is up to date with src/worker-entry.ts (run `npm run build:worker` if this fails)', () => {
    const script = join(__dirname, '..', 'scripts', 'build-worker.mjs');
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  }, 30_000);
});
