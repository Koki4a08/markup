import type { CaptureEnv } from './env';
import { get, type Decl } from './styles';

/** The only image sources the app's paste handler keeps. */
export const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i;
/** Data URLs past this length (≈ an 8 MB image) are treated as unavailable. */
export const MAX_DATA_URL = 11_500_000;
export const PLACEHOLDER_COLOR = '#e4e4e7';
export const PLACEHOLDER_NAME = 'Image unavailable';

/** A data URL we can put inside url() or src="" unquoted and unescaped. */
export const usableDataUrl = (v: string | null | undefined): v is string =>
  !!v && SAFE_IMAGE.test(v) && v.length <= MAX_DATA_URL && !/[\s"'()\\<>]/.test(v);

/**
 * Fetches each distinct URL once, a few at a time; failures, unusable results and anything past the running
 * byte budget become null (so the caller falls back to a placeholder).
 */
export class ImageLoader {
  private readonly cache = new Map<string, Promise<string | null>>();
  private readonly queue: (() => void)[] = [];
  private active = 0;
  private used = 0;

  constructor(
    private readonly env: CaptureEnv,
    private readonly limits: { imageBytes: number; concurrency: number } = { imageBytes: 40_000_000, concurrency: 6 },
  ) {}

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    // A finishing fetch hands its slot straight to the next waiter, so the count never overshoots.
    if (this.active >= this.limits.concurrency) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }

  /** Charges a data URL against the budget; null when it is unusable or would exceed it. */
  admit(v: string | null): string | null {
    if (!usableDataUrl(v) || this.used + v.length > this.limits.imageBytes) return null;
    this.used += v.length;
    return v;
  }

  get(url: string): Promise<string | null> {
    const key = url.trim();
    if (!key) return Promise.resolve(null);
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.slot(() => this.env.fetchImage(key)).then(
        (v) => this.admit(v),
        () => null,
      );
      this.cache.set(key, hit);
    }
    return hit;
  }
}

/** Splits a CSS list on top-level commas. */
export function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote) {
      if (ch === '\\') {
        cur += ch + (value[++i] ?? '');
        continue;
      }
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The URL inside the first url(…) (or bare string in image-set) of a value, with CSS escapes removed. */
export function firstUrl(value: string): string | null {
  const m = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)|(?:image-set\(\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/i.exec(value);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
  return raw.replace(/\\(.)/g, '$1');
}

const GRADIENT = /^(repeating-)?(linear|radial|conic)-gradient\(/i;

/**
 * background-image (gradients kept, url() and image-set() inlined as data URLs) plus the matching size, position
 * and repeat lists. Layers whose image cannot be loaded are dropped.
 */
export async function backgroundDecls(cs: CSSStyleDeclaration, images: ImageLoader): Promise<Decl[]> {
  const value = get(cs, 'background-image');
  if (!value || value === 'none') return [];
  const layers = splitTopLevel(value);
  const resolved = await Promise.all(
    layers.map(async (layer) => {
      if (GRADIENT.test(layer)) return /url\(|image-set\(/i.test(layer) ? null : layer;
      if (!/^(url|(-webkit-)?image-set)\(/i.test(layer)) return null;
      const url = firstUrl(layer);
      const data = url ? await images.get(url) : null;
      return data ? `url(${data})` : null;
    }),
  );
  const keep = resolved.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (!keep.length) return [];
  const out: Decl[] = [['background-image', keep.map((i) => resolved[i]!).join(', ')]];
  const pick = (v: string) => {
    const parts = splitTopLevel(v);
    return parts.length === layers.length ? keep.map((i) => parts[i]!).join(', ') : v;
  };
  for (const [prop, initial] of [['background-size', /^auto( auto)?$/], ['background-position', /^0% 0%$/], ['background-repeat', /^repeat$/]] as const) {
    const v = get(cs, prop);
    if (!v) continue;
    const picked = pick(v);
    if (!splitTopLevel(picked).every((p) => initial.test(p))) out.push([prop, picked]);
  }
  return out;
}

/** The pixels the user sees, cut from a screenshot of the visible tab (private, cross-origin or tainted images). */
export async function screenImage(env: CaptureEnv, images: ImageLoader, el: Element): Promise<string | null> {
  if (!env.snapshotRegion) return null;
  try {
    return images.admit(await env.snapshotRegion(env.rect(el)));
  } catch {
    return null;
  }
}
