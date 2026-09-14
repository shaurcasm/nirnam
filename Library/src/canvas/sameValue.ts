/**
 * Structural equality for the plain data that crosses the worker boundary.
 *
 * State reaches a surface as a structured clone, so a surface can never tell
 * "the same state again" from "new state" by identity — every message is a
 * fresh object. This is the comparison the host and `layers()` use instead,
 * so a surface only hears about state that actually changed.
 *
 * Only primitives, arrays and plain objects compare by value. Anything else
 * a structured clone can carry — a Map, a Set, a Date, a typed array — is
 * treated as changed unless it is the very same reference: better a spare
 * message than a swallowed one.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  if (!isPlain(a) || !isPlain(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const objB = b as Record<string, unknown>;
  return keysA.every(key => Object.prototype.hasOwnProperty.call(objB, key) && sameValue((a as Record<string, unknown>)[key], objB[key]));
}

/** A plain object, from this realm or another: its prototype is an `Object.prototype`, or nothing. */
function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}
