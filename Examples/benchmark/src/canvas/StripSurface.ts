/**
 * A surface shaped like Wevaad's trees, without the art: a handful of
 * bitmaps painted once (expensive — gradients, grain, thousands of
 * strokes) and then drawn every frame as horizontal strips offset by a
 * sway that grows with height, so the bottom stands still and the top
 * moves. The per-frame cost is `strips` calls to `drawImage`; the one-off
 * cost of a repaint is reported through `input.report('rebuild', ms)`.
 *
 * The same object runs in the worker and on the main thread. Nothing in it
 * knows which.
 */

import type { Surface, SurfaceSize, FrameInput } from '@palinc/nirnam/canvas';

export interface StripState {
  /** `drawImage` calls per frame, spread over the bitmaps. Wevaad's tree pair is about 340. */
  strips: number;
  /** A change repaints the bitmaps — the "route changed" of the trees. */
  variant: number;
}

const BITMAPS = 6;
const SWAY_PERIOD_MS = 4000;

function paintBitmap(width: number, height: number, seed: number): OffscreenCanvas {
  const bitmap = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const ctx = bitmap.getContext('2d')!;
  let s = seed * 9301 + 49297;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const hue = 90 + seed * 37;
  // A body with a gradient across it.
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, `hsl(${hue} 40% 18%)`);
  grad.addColorStop(0.5, `hsl(${hue} 45% 36%)`);
  grad.addColorStop(1, `hsl(${hue} 40% 14%)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(width / 2, height / 2, width / 2.2, height / 2.05, 0, 0, Math.PI * 2);
  ctx.fill();
  // Grain: many short strokes, like bark fissures and tuft edges.
  ctx.lineWidth = 1;
  for (let i = 0; i < 2500; i++) {
    ctx.strokeStyle = `hsla(${hue} 50% ${20 + rand() * 50}% / ${0.15 + rand() * 0.3})`;
    const x = rand() * width;
    const y = rand() * height;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 12, y + rand() * 20);
    ctx.stroke();
  }
  // Tufts: scalloped blobs with a lit cap.
  for (let i = 0; i < 300; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const r = 6 + rand() * 18;
    ctx.fillStyle = `hsla(${hue + 10} 45% ${25 + rand() * 30}% / 0.8)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsla(${hue + 20} 60% 70% / 0.35)`;
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  return bitmap;
}

export class StripSurface implements Surface<StripState> {
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private size: SurfaceSize = { width: 0, height: 0, dpr: 1 };
  private bitmaps: OffscreenCanvas[] = [];
  private strips = 400;
  private variant = 0;
  private dirty = true;
  /** Frames drawn since attach — the proof both arms did the same work. */
  frames = 0;

  attach(canvas: OffscreenCanvas, size: SurfaceSize): void {
    this.ctx = canvas.getContext('2d');
    this.resize(size);
  }

  resize(size: SurfaceSize): void {
    this.size = size;
    this.dirty = true;
  }

  onState(state: StripState): void {
    this.strips = state.strips;
    if (state.variant !== this.variant) {
      this.variant = state.variant;
      this.dirty = true;
    }
  }

  private rebuild(report?: FrameInput['report']): void {
    const before = performance.now();
    const { width, height, dpr } = this.size;
    const w = Math.round((width / 3) * dpr);
    const h = Math.round(height * 0.8 * dpr);
    this.bitmaps = Array.from({ length: BITMAPS }, (_, i) => paintBitmap(w, h, i + this.variant * BITMAPS));
    this.dirty = false;
    report?.('rebuild', performance.now() - before);
  }

  frame(_dt: number, input: FrameInput): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.dirty) this.rebuild(input.report);
    const { width, height, dpr } = this.size;
    const sway = Math.sin((input.elapsed / SWAY_PERIOD_MS) * Math.PI * 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const perBitmap = Math.max(1, Math.round(this.strips / this.bitmaps.length));
    this.bitmaps.forEach((bitmap, b) => {
      const x0 = ((b % 3) * width * dpr) / 3;
      const y0 = (b < 3 ? 0.05 : 0.15) * height * dpr;
      const stripH = bitmap.height / perBitmap;
      for (let i = 0; i < perBitmap; i++) {
        const sy = i * stripH;
        // Height² so the base stays put and the top swings.
        const t = 1 - i / perBitmap;
        const dx = sway * 18 * dpr * t * t * (b % 2 ? 1 : -1);
        ctx.drawImage(bitmap, 0, sy, bitmap.width, stripH, x0 + dx, y0 + sy, bitmap.width, stripH);
      }
    });
    this.frames += 1;
  }

  detach(): void {
    this.bitmaps = [];
    this.ctx = null;
  }
}
