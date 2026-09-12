import { resolveMotionTier, probeMotionCapabilities } from '../src/canvas/tier';
import type { MotionCapabilities } from '../src/canvas/tier';

const capable: MotionCapabilities = {
  offscreenCanvas: true,
  reducedMotion: false,
  finePointer: true,
  lowEnd: false,
};

describe('resolveMotionTier', () => {
  it('gives a capable desktop the full tier', () => {
    expect(resolveMotionTier(capable)).toBe('full');
  });

  it('is off without OffscreenCanvas, whatever the user asked', () => {
    const caps = { ...capable, offscreenCanvas: false };
    expect(resolveMotionTier(caps, 'auto')).toBe('off');
    expect(resolveMotionTier(caps, 'on')).toBe('off');
  });

  it('is off under prefers-reduced-motion, and the user preference cannot override that', () => {
    const caps = { ...capable, reducedMotion: true };
    expect(resolveMotionTier(caps, 'auto')).toBe('off');
    expect(resolveMotionTier(caps, 'on')).toBe('off');
  });

  it('drops to ambient on a low-end device', () => {
    expect(resolveMotionTier({ ...capable, lowEnd: true })).toBe('ambient');
  });

  it('drops to ambient without a fine pointer — nothing to react to', () => {
    expect(resolveMotionTier({ ...capable, finePointer: false })).toBe('ambient');
  });

  it('lets the user force full past the low-end and coarse-pointer downgrades', () => {
    expect(resolveMotionTier({ ...capable, lowEnd: true, finePointer: false }, 'on')).toBe('full');
  });

  it('lets the user turn it off on a capable device', () => {
    expect(resolveMotionTier(capable, 'off')).toBe('off');
  });
});

describe('probeMotionCapabilities', () => {
  const env = (overrides: Partial<Parameters<typeof probeMotionCapabilities>[0]> = {}) => ({
    hasOffscreenCanvas: true,
    matchMedia: (query: string) => ({ matches: query.includes('hover: hover') }),
    hardwareConcurrency: 8,
    deviceMemory: 8,
    ...overrides,
  });

  it('reads a capable desktop', () => {
    expect(probeMotionCapabilities(env())).toEqual(capable);
  });

  it('reads reduced motion from the media query', () => {
    const e = env({ matchMedia: (q) => ({ matches: q.includes('reduce') || q.includes('hover: hover') }) });
    expect(probeMotionCapabilities(e).reducedMotion).toBe(true);
  });

  it('reads a coarse pointer', () => {
    expect(probeMotionCapabilities(env({ matchMedia: () => ({ matches: false }) })).finePointer).toBe(false);
  });

  it('calls four or fewer cores, or under 4 GB, low-end', () => {
    expect(probeMotionCapabilities(env({ hardwareConcurrency: 4 })).lowEnd).toBe(true);
    expect(probeMotionCapabilities(env({ deviceMemory: 2 })).lowEnd).toBe(true);
    expect(probeMotionCapabilities(env({ hardwareConcurrency: 6, deviceMemory: 4 })).lowEnd).toBe(false);
  });

  it('assumes a mid-range device when the hardware hints are missing', () => {
    expect(probeMotionCapabilities(env({ hardwareConcurrency: undefined, deviceMemory: undefined })).lowEnd).toBe(false);
  });

  it('assumes no reduced motion and a coarse pointer without matchMedia', () => {
    const caps = probeMotionCapabilities(env({ matchMedia: undefined }));
    expect(caps.reducedMotion).toBe(false);
    expect(caps.finePointer).toBe(false);
  });

  it('reads the real browser globals by default without throwing in Node', () => {
    expect(() => probeMotionCapabilities()).not.toThrow();
    expect(probeMotionCapabilities().offscreenCanvas).toBe(false);
  });
});
