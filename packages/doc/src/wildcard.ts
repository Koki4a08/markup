/** Anchored glob: `*` matches any run of characters. */
export function wildcard(pattern: string, flags = ''): RegExp {
  const escaped = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`, flags);
}
