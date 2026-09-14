/**
 * The orchestrator and its two layers, in a module the worker entry and the
 * inline (main-thread) arm both call — the same code either side of the
 * thread boundary, which is what makes the toggle in App.tsx a fair
 * comparison. A field of drifting particles underneath, a bouncing dot that
 * follows the pointer and swaps colour with the "route" on top. One canvas
 * rather than two because the compositor pays per canvas, every frame,
 * however little was drawn. Joining the bus lets the page steer it with
 * topics instead of prop drilling.
 */

import { connectWorkerBus } from '@palinc/nirnam/worker';
import { createOrchestrator, layers } from '@palinc/nirnam/canvas';
import type { Surface, SurfaceSize, FrameInput, OrchestratorScope } from '@palinc/nirnam/canvas';

interface DotState {
  route: 'login' | 'home';
}

class DotSurface implements Surface<DotState> {
  private ctx!: OffscreenCanvasRenderingContext2D;
  private size!: SurfaceSize;
  private x = 100;
  private y = 100;
  private vx = 0.12;
  private vy = 0.09;
  private colour = '#22d3ee';
  private target: { x: number; y: number } | null = null;

  attach(canvas: OffscreenCanvas, size: SurfaceSize) {
    this.ctx = canvas.getContext('2d')!;
    this.resize(size);
  }

  resize(size: SurfaceSize) {
    this.size = size;
    this.ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  }

  onState(state: DotState) {
    this.colour = state.route === 'home' ? '#34d399' : '#22d3ee';
    // The route change is the transition: the dot heads for the new anchor.
    this.target = state.route === 'home'
      ? { x: this.size.width * 0.8, y: this.size.height * 0.3 }
      : { x: this.size.width * 0.5, y: this.size.height * 0.5 };
  }

  frame(dt: number, input: FrameInput) {
    const { width, height } = input.size;
    const r = 24;

    if (input.pointer?.inside) {
      // Full tier: the dot is drawn toward the pointer.
      this.vx += (input.pointer.x - this.x) * 0.00002 * dt;
      this.vy += (input.pointer.y - this.y) * 0.00002 * dt;
    } else if (this.target) {
      this.vx += (this.target.x - this.x) * 0.00001 * dt;
      this.vy += (this.target.y - this.y) * 0.00001 * dt;
    }
    this.vx *= 0.995;
    this.vy *= 0.995;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.x < r || this.x > width - r) { this.vx *= -1; this.x = Math.max(r, Math.min(width - r, this.x)); }
    if (this.y < r || this.y > height - r) { this.vy *= -1; this.y = Math.max(r, Math.min(height - r, this.y)); }

    // The composite cleared the canvas; a layer only draws.
    const ctx = this.ctx;
    ctx.setTransform(input.size.dpr, 0, 0, input.size.dpr, 0, 0);
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.fillStyle = this.colour;
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '12px system-ui';
    ctx.fillText(`${input.tier} · ${Math.round(input.elapsed / 1000)}s`, 12, height - 12);
  }
}

class FieldSurface implements Surface {
  private ctx!: OffscreenCanvasRenderingContext2D;
  private points: Array<{ x: number; y: number; vx: number; vy: number }> = [];

  attach(canvas: OffscreenCanvas, size: SurfaceSize) {
    this.ctx = canvas.getContext('2d')!;
    this.resize(size);
    this.points = Array.from({ length: 120 }, () => ({
      x: Math.random() * size.width,
      y: Math.random() * size.height,
      vx: (Math.random() - 0.5) * 0.02,
      vy: (Math.random() - 0.5) * 0.02,
    }));
  }

  resize(size: SurfaceSize) {
    this.ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  }

  frame(dt: number, input: FrameInput) {
    const { width, height } = input.size;
    const ctx = this.ctx;
    ctx.setTransform(input.size.dpr, 0, 0, input.size.dpr, 0, 0);
    ctx.fillStyle = 'rgba(148,163,184,0.5)';
    for (const p of this.points) {
      if (input.pointer) {
        const dx = p.x - input.pointer.x;
        const dy = p.y - input.pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 120 * 120) {
          p.vx += (dx / Math.sqrt(d2 + 1)) * 0.002 * dt;
          p.vy += (dy / Math.sqrt(d2 + 1)) * 0.002 * dt;
        }
      }
      p.vx *= 0.99;
      p.vy *= 0.99;
      p.x = (p.x + p.vx * dt + width) % width;
      p.y = (p.y + p.vy * dt + height) % height;
      ctx.fillRect(p.x, p.y, 3, 3);
    }
  }
}

/** Create the orchestrator on `scope` and join the bus through it. Returns the orchestrator so `terminate()` can dispose it. */
export function setupOrchestrator(scope?: OrchestratorScope) {
  const orchestrator = createOrchestrator({
    surfaces: {
      background: layers({ field: () => new FieldSurface(), dot: () => new DotSurface() }),
    },
    statsIntervalMs: 1000,
    scope,
  });

  // The bus: route changes arrive as a topic and are routed to the dot layer.
  connectWorkerBus({ scope }).then(bus => {
    bus.subscribe<DotState['route']>('example:route', route => orchestrator.setState('background', { dot: { route } }));
    bus.handle('example:ping', () => `pong from the ${scope ? 'main thread' : 'worker'}`);
  });

  return orchestrator;
}
