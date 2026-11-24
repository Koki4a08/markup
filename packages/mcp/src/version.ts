declare const __MARKUP_VERSION__: string | undefined;

/** Set at build time from apps/app/src-tauri/tauri.conf.json (build.mjs, compile.mjs). */
export const VERSION: string = typeof __MARKUP_VERSION__ === 'string' ? __MARKUP_VERSION__ : '0.0.0-dev';

/** Numeric compare of dotted versions, ignoring a leading "v" and any pre-release suffix. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
