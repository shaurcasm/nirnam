/**
 * Which tier a device gets — probed at runtime, never from the user agent.
 *
 * The creative work runs at full strength wherever it can and is gated, not
 * diluted, elsewhere. The user has a say (`on` forces past the hardware
 * downgrades) but never past `prefers-reduced-motion`, and nothing runs
 * where `OffscreenCanvas` cannot be transferred.
 */

import type { MotionTier } from './types';

export interface MotionCapabilities {
  /** `transferControlToOffscreen` exists — without it there is nothing to run. */
  offscreenCanvas: boolean;
  /** The OS asked for reduced motion. Overrides everything, including the user toggle. */
  reducedMotion: boolean;
  /** A mouse or trackpad — something that hovers. Touch has nothing to react to between taps. */
  finePointer: boolean;
  /** Few cores or little memory: the worker is not free here. */
  lowEnd: boolean;
}

/** What the user chose, if anything. `auto` trusts the probe. */
export type MotionPreference = 'auto' | 'on' | 'off';

export function resolveMotionTier(caps: MotionCapabilities, preference: MotionPreference = 'auto'): MotionTier {
  if (!caps.offscreenCanvas || caps.reducedMotion || preference === 'off') return 'off';
  if (preference === 'on') return 'full';
  return caps.lowEnd || !caps.finePointer ? 'ambient' : 'full';
}

/** The browser globals the probe reads, injectable for tests. */
export interface ProbeEnvironment {
  hasOffscreenCanvas: boolean;
  matchMedia?: (query: string) => { matches: boolean };
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

function browserEnvironment(): ProbeEnvironment {
  const g = globalThis as unknown as {
    HTMLCanvasElement?: { prototype: object };
    matchMedia?: (query: string) => { matches: boolean };
    navigator?: { hardwareConcurrency?: number; deviceMemory?: number };
  };
  return {
    hasOffscreenCanvas: !!g.HTMLCanvasElement && 'transferControlToOffscreen' in g.HTMLCanvasElement.prototype,
    matchMedia: g.matchMedia?.bind(g),
    hardwareConcurrency: g.navigator?.hardwareConcurrency,
    deviceMemory: g.navigator?.deviceMemory,
  };
}

const LOW_END_CORES = 4;
const LOW_END_MEMORY_GB = 4;

export function probeMotionCapabilities(env: ProbeEnvironment = browserEnvironment()): MotionCapabilities {
  const media = (query: string) => env.matchMedia?.(query).matches ?? false;
  return {
    offscreenCanvas: env.hasOffscreenCanvas,
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
    finePointer: media('(hover: hover) and (pointer: fine)'),
    lowEnd:
      (env.hardwareConcurrency ?? LOW_END_CORES + 1) <= LOW_END_CORES ||
      (env.deviceMemory ?? LOW_END_MEMORY_GB) < LOW_END_MEMORY_GB,
  };
}
