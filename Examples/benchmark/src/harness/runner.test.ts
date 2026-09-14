import { describe, it, expect, vi } from 'vitest';
import { runCases } from './runner';

const settle = () => Promise.resolve();

describe('runCases', () => {
  it('warms up, repeats, and reports the median per metric', async () => {
    let n = 0;
    const results = await runCases(
      [{ arm: 'a', armLabel: 'A', workload: 'w', workloadLabel: 'W', run: async () => ({ wall: [100, 30, 10, 20][n++] }) }],
      { reps: 3, warmup: 1, settle },
    );
    expect(results).toHaveLength(1);
    // The 100 was the warm-up and is not in the runs.
    expect(results[0].runs.map(r => r.wall)).toEqual([30, 10, 20]);
    expect(results[0].metrics).toEqual({ wall: 20 });
  });

  it('keeps unsupported cases in the table with their reason', async () => {
    const results = await runCases([{ arm: 'a', armLabel: 'A', workload: 'w', workloadLabel: 'W', unsupported: 'no worker reach' }], { settle });
    expect(results[0].metrics).toBeNull();
    expect(results[0].unsupported).toBe('no worker reach');
  });

  it('records an error instead of throwing, and moves on to the next case', async () => {
    const results = await runCases(
      [
        { arm: 'a', armLabel: 'A', workload: 'w', workloadLabel: 'W', run: async () => { throw new Error('boom'); } },
        { arm: 'b', armLabel: 'B', workload: 'w', workloadLabel: 'W', run: async () => ({ wall: 1 }) },
      ],
      { reps: 1, warmup: 0, settle },
    );
    expect(results[0].error).toBe('boom');
    expect(results[0].metrics).toBeNull();
    expect(results[1].metrics).toEqual({ wall: 1 });
  });

  it('reports progress as runs complete and a final null current', async () => {
    const onProgress = vi.fn();
    await runCases([{ arm: 'a', armLabel: 'A', workload: 'w', workloadLabel: 'W', run: async () => ({ wall: 1 }) }], {
      reps: 2,
      warmup: 1,
      settle,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onProgress.mock.calls[0][0]).toMatchObject({ done: 0, total: 3 });
    expect(onProgress.mock.calls[3][0]).toMatchObject({ done: 3, total: 3, current: null });
  });

  it('stops early when aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const results = await runCases(
      [{ arm: 'a', armLabel: 'A', workload: 'w', workloadLabel: 'W', run: async () => { calls += 1; if (calls === 2) controller.abort(); return { wall: calls }; } }],
      { reps: 5, warmup: 0, settle, signal: controller.signal },
    );
    expect(calls).toBe(2);
    expect(results[0].runs).toHaveLength(2);
  });
});
