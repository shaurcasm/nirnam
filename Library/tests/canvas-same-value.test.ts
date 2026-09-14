/**
 * `sameValue` — the by-value comparison state is deduplicated with.
 */

import { sameValue } from '../src/canvas/sameValue';

describe('sameValue', () => {
  it('compares primitives, arrays and plain objects by value, in any nesting', () => {
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue('a', 'b')).toBe(false);
    expect(sameValue(NaN, NaN)).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, undefined)).toBe(false);
    expect(sameValue([1, [2, { x: 3 }]], [1, [2, { x: 3 }]])).toBe(true);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue({ a: 1 }, [1])).toBe(false);
  });

  it('is what a structured clone is to its original', () => {
    const state = { route: 'home', palette: { canopy: ['#1', '#2', '#3'] }, pulse: { id: 3 } };
    expect(sameValue(state, structuredClone(state))).toBe(true);
    expect(sameValue(state, { ...state, pulse: { id: 4 } })).toBe(false);
  });

  it('never calls two distinct exotic objects equal — a Map, a Set, a Date, a typed array', () => {
    expect(sameValue(new Map([[1, 2]]), new Map([[1, 2]]))).toBe(false);
    expect(sameValue(new Set([1]), new Set([1]))).toBe(false);
    expect(sameValue(new Date(0), new Date(0))).toBe(false);
    expect(sameValue(new Float32Array([1]), new Float32Array([1]))).toBe(false);
    const map = new Map();
    expect(sameValue({ map }, { map })).toBe(true);
  });
});
