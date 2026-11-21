/**
 * Deep equality for snapshot values (plain objects, arrays and primitives), matching what a JSON
 * comparison would treat as equal without serializing: strings compare with ===, so an unchanged
 * data URL or SVG string costs O(1) when Yjs hands back the same instance. Keys whose value is
 * undefined are ignored, as JSON drops them. Values that are not plain objects or arrays (Dates,
 * class instances) fall back to comparing their JSON.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aArray = Array.isArray(a);
  if (aArray !== Array.isArray(b)) return false;
  if (aArray) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!structurallyEqual(x[i], y[i])) return false;
    return true;
  }
  if (!isPlain(a) || !isPlain(b)) return JSON.stringify(a) === JSON.stringify(b);
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k in x) if (Object.prototype.hasOwnProperty.call(x, k) && !structurallyEqual(x[k], y[k])) return false;
  for (const k in y) if (Object.prototype.hasOwnProperty.call(y, k) && !Object.prototype.hasOwnProperty.call(x, k) && y[k] !== undefined) return false;
  return true;
}

function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
