/**
 * `layers()` — several surfaces drawn into one canvas, in order.
 *
 * Every canvas the compositor has to upload and blend costs the same
 * whether much or little was drawn into it, so a background made of a few
 * surfaces should be one canvas, not one per surface. The composite clears
 * once per frame and lets each layer draw over the last.
 */

import { layers } from '../src/canvas/layers';
import type { Surface, SurfaceSize, FrameInput } from '../src/canvas/types';

interface Spy extends Surface<{ n: number }> {
  calls: string[];
}

function spy(name: string, log: string[]): Spy {
  const s: Spy = {
    calls: log,
    attach: () => log.push(`${name}:attach`),
    resize: () => log.push(`${name}:resize`),
    frame: () => log.push(`${name}:frame`),
    onState: (st) => log.push(`${name}:state:${st.n}`),
    detach: () => log.push(`${name}:detach`),
  };
  return s;
}

const size: SurfaceSize = { width: 200, height: 100, dpr: 2 };
const input: FrameInput = { pointer: null, tier: 'full', size, elapsed: 0 };

function canvas() {
  const ctx = { clearRect: jest.fn(), setTransform: jest.fn() };
  return { canvas: { getContext: jest.fn(() => ctx) } as unknown as OffscreenCanvas, ctx };
}

describe('layers', () => {
  it('attaches, resizes, frames and detaches every layer in order', () => {
    const log: string[] = [];
    const composite = layers(() => spy('a', log), () => spy('b', log))();
    const { canvas: c } = canvas();

    composite.attach(c, size);
    composite.resize?.(size);
    composite.frame(16, input);
    composite.detach?.();

    expect(log).toEqual(['a:attach', 'b:attach', 'a:resize', 'b:resize', 'a:frame', 'b:frame', 'a:detach', 'b:detach']);
  });

  it('clears the canvas once per frame, in device pixels, before any layer draws', () => {
    const log: string[] = [];
    const composite = layers(() => spy('a', log))();
    const { canvas: c, ctx } = canvas();
    composite.attach(c, size);

    ctx.clearRect.mockImplementation(() => log.push('clear'));
    composite.frame(16, input);

    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 400, 200);
    expect(log).toEqual(['a:attach', 'clear', 'a:frame']);
  });

  it('can be told not to clear, for layers that paint the whole surface themselves', () => {
    const composite = layers({ clear: false }, () => spy('a', []))();
    const { canvas: c, ctx } = canvas();
    composite.attach(c, size);
    composite.frame(16, input);
    expect(ctx.clearRect).not.toHaveBeenCalled();
  });

  it('routes state to the layer named in it, in layer order', () => {
    const log: string[] = [];
    const composite = layers({ a: () => spy('a', log), b: () => spy('b', log) })();
    composite.attach(canvas().canvas, size);

    composite.onState?.({ a: { n: 1 } });
    composite.onState?.({ b: { n: 2 }, a: { n: 3 } });
    composite.onState?.({ c: { n: 9 } });

    expect(log.filter(l => l.includes('state'))).toEqual(['a:state:1', 'a:state:3', 'b:state:2']);
  });

  it('gives a layer its slice only when the slice changed by value — a structured clone is not a change', () => {
    const log: string[] = [];
    const composite = layers({ a: () => spy('a', log), b: () => spy('b', log) })();
    composite.attach(canvas().canvas, size);

    composite.onState?.({ a: { n: 1 }, b: { n: 1 } });
    // The whole state again, cloned: nobody hears anything.
    composite.onState?.(structuredClone({ a: { n: 1 }, b: { n: 1 } }));
    // Only b changed: a keeps quiet.
    composite.onState?.({ a: { n: 1 }, b: { n: 2 } });
    composite.onState?.({ a: { n: 2 } });

    expect(log.filter(l => l.includes('state'))).toEqual(['a:state:1', 'b:state:1', 'b:state:2', 'a:state:2']);
  });

  it('files a cost a layer reports under the layer\'s name', () => {
    const report = jest.fn();
    const reporter: Surface = { attach: jest.fn(), frame: (_dt, input) => input.report?.('rebuild', 40) };
    const composite = layers({ tree: () => reporter })();
    composite.attach(canvas().canvas, size);

    composite.frame(16, { ...input, report });
    expect(report).toHaveBeenCalledWith('tree:rebuild', 40);

    // An unnamed layer reports as itself; without a reporter nothing is called.
    const anonymous = layers(() => reporter)();
    anonymous.attach(canvas().canvas, size);
    report.mockClear();
    anonymous.frame(16, { ...input, report });
    expect(report).toHaveBeenCalledWith('rebuild', 40);
    expect(() => anonymous.frame(16, input)).not.toThrow();
  });

  it('tolerates layers without the optional methods', () => {
    const minimal: Surface = { attach: jest.fn(), frame: jest.fn() };
    const composite = layers(() => minimal)();
    composite.attach(canvas().canvas, size);
    expect(() => {
      composite.resize?.(size);
      composite.frame(16, input);
      composite.onState?.({ x: 1 });
      composite.detach?.();
    }).not.toThrow();
    expect(minimal.frame).toHaveBeenCalledTimes(1);
  });
});
