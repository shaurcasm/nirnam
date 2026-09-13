/**
 * Several surfaces on one canvas.
 *
 * The compositor pays per canvas, not per drawn pixel: every canvas element
 * is a texture to upload and a layer to blend, every frame, however little
 * changed in it. A background made of a tree, its leaves and a sky should
 * therefore be one canvas with three layers, not three canvases. `layers()`
 * builds that composite: one attach, one clear per frame, each layer drawn
 * over the last, and state routed to the layer it names.
 *
 *   createOrchestrator({
 *     surfaces: {
 *       background: layers({ tree: () => new Tree(), leaves: () => new Leaves() }),
 *     },
 *   });
 *   // host side: setState('background', { tree: { anchor: 'home' } })
 *
 * Layers must not clear the canvas themselves.
 */

import type { Surface, SurfaceFactory, SurfaceSize, FrameInput } from './types';

export interface LayersOptions {
  /** Clear the whole canvas before the first layer draws. Default `true`. */
  clear?: boolean;
}

type NamedFactories = Record<string, SurfaceFactory>;

export function layers(...factories: SurfaceFactory[]): SurfaceFactory;
export function layers(named: NamedFactories): SurfaceFactory;
export function layers(options: LayersOptions, ...factories: SurfaceFactory[]): SurfaceFactory;
export function layers(options: LayersOptions, named: NamedFactories): SurfaceFactory;
export function layers(...args: unknown[]): SurfaceFactory {
  let options: LayersOptions = {};
  let rest = args;
  if (rest.length > 0 && typeof rest[0] === 'object' && rest[0] !== null && !isNamed(rest[0])) {
    options = rest[0] as LayersOptions;
    rest = rest.slice(1);
  }
  const named: Array<[string | null, SurfaceFactory]> =
    rest.length === 1 && isNamed(rest[0])
      ? Object.entries(rest[0] as NamedFactories)
      : (rest as SurfaceFactory[]).map(f => [null, f]);
  const clear = options.clear ?? true;

  return () => new Composite(named, clear);
}

/** A plain object whose values are all functions: the `{ name: factory }` form. */
function isNamed(value: unknown): value is NamedFactories {
  if (typeof value !== 'object' || value === null) return false;
  const values = Object.values(value as Record<string, unknown>);
  return values.length > 0 && values.every(v => typeof v === 'function');
}

class Composite implements Surface<Record<string, unknown>> {
  private readonly layers: Array<{ name: string | null; surface: Surface }>;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private size: SurfaceSize | null = null;

  constructor(named: Array<[string | null, SurfaceFactory]>, private readonly clear: boolean) {
    this.layers = named.map(([name, factory]) => ({ name, surface: factory() }));
  }

  attach(canvas: OffscreenCanvas, size: SurfaceSize): void {
    this.ctx = canvas.getContext('2d');
    this.size = size;
    this.layers.forEach(l => l.surface.attach(canvas, size));
  }

  resize(size: SurfaceSize): void {
    this.size = size;
    this.layers.forEach(l => l.surface.resize?.(size));
  }

  frame(dt: number, input: FrameInput): void {
    if (this.clear && this.ctx && this.size) {
      // Device pixels, independent of whatever transform a layer left behind.
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.size.width * this.size.dpr, this.size.height * this.size.dpr);
    }
    this.layers.forEach(l => l.surface.frame(dt, input));
  }

  onState(state: Record<string, unknown>): void {
    this.layers.forEach(l => {
      if (l.name !== null && l.name in state) l.surface.onState?.(state[l.name]);
    });
  }

  detach(): void {
    this.layers.forEach(l => l.surface.detach?.());
  }
}
