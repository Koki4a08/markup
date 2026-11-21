/**
 * Moving pixels a snapshot keeps moving: a WebGL shader, an animated 2D canvas or a playing video is recorded for a
 * few seconds while it is on screen and stored as a looping animated WebP, which the app shows like any image.
 * The browser encodes each frame (canvas.toBlob as WebP); the frames are then put into one animated WebP file.
 */
import { readBlob } from './images';

export type ClipSource = HTMLCanvasElement | HTMLVideoElement;

export interface ClipOptions {
  durationMs?: number;
  fps?: number;
  /** Longest side of the recorded frames, in pixels. */
  maxSide?: number;
  quality?: number;
  /** Largest file kept, in bytes (frames are thinned out to fit, then the clip is dropped). */
  maxBytes?: number;
}

const DEFAULTS: Required<ClipOptions> = { durationMs: 3000, fps: 15, maxSide: 720, quality: 0.82, maxBytes: 6_000_000 };
/** Fewer frames than this is a slideshow, not motion: the still frame is kept instead. */
const MIN_FRAMES = 6;

// ── WebP container ─────────────────────────────────────────────────────────────────────────────────

interface Chunk {
  id: string;
  /** The whole chunk: header, payload and padding byte. */
  raw: Uint8Array;
}

const fourCC = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/** The chunks of a WebP file, or null when it is not one. */
export function webpChunks(bytes: Uint8Array): Chunk[] | null {
  if (bytes.length < 20 || fourCC(bytes, 0) !== 'RIFF' || fourCC(bytes, 8) !== 'WEBP') return null;
  const out: Chunk[] = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = u32(bytes, at + 4);
    const end = at + 8 + size + (size & 1);
    if (at + 8 + size > bytes.length) return null;
    out.push({ id: fourCC(bytes, at), raw: bytes.subarray(at, Math.min(end, bytes.length)) });
    at = end;
  }
  return out;
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  length = 0;

  bytes(b: Uint8Array | number[]): this {
    const a = b instanceof Uint8Array ? b : Uint8Array.from(b);
    this.parts.push(a);
    this.length += a.length;
    return this;
  }

  ascii(s: string): this {
    return this.bytes([...s].map((c) => c.charCodeAt(0)));
  }

  u16(n: number): this {
    return this.bytes([n & 0xff, (n >>> 8) & 0xff]);
  }

  u24(n: number): this {
    return this.bytes([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]);
  }

  u32(n: number): this {
    return this.bytes([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  }

  /** A chunk around the payload this writer holds. */
  chunk(id: string): Uint8Array {
    const pad = this.length & 1;
    return new Writer().ascii(id).u32(this.length).bytes(this.join()).bytes(pad ? [0] : []).join();
  }

  join(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/**
 * One looping animated WebP from still WebP frames of the same size (as canvas.toBlob makes them). Each frame
 * replaces the previous one outright (no blending, no disposal). Null when a frame is not a WebP image.
 */
export function animatedWebp(frames: Uint8Array[], width: number, height: number, frameMs: number): Uint8Array | null {
  if (!frames.length || width < 1 || height < 1 || width > 1 << 24 || height > 1 << 24) return null;
  let alpha = false;
  const anmf: Uint8Array[] = [];
  const duration = Math.max(1, Math.min(0xffffff, Math.round(frameMs)));
  for (const f of frames) {
    const chunks = webpChunks(f);
    const image = chunks?.filter((c) => c.id === 'ALPH' || c.id === 'VP8 ' || c.id === 'VP8L');
    if (!image?.some((c) => c.id !== 'ALPH')) return null;
    if (image.some((c) => c.id !== 'VP8 ')) alpha = true;
    const w = new Writer().u24(0).u24(0).u24(width - 1).u24(height - 1).u24(duration).bytes([0b10]);
    for (const c of image) w.bytes(c.raw);
    anmf.push(w.chunk('ANMF'));
  }
  const vp8x = new Writer().bytes([0b10 | (alpha ? 0b10000 : 0), 0, 0, 0]).u24(width - 1).u24(height - 1).chunk('VP8X');
  const anim = new Writer().u32(0).u16(0).chunk('ANIM');
  const body = new Writer().ascii('WEBP').bytes(vp8x).bytes(anim);
  for (const a of anmf) body.bytes(a);
  return new Writer().ascii('RIFF').u32(body.length).bytes(body.join()).join();
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The frames to keep: every frame when they fit the byte budget, else every 2nd, 4th… (each shown longer);
 * null when the frames never change (nothing moves) or no thinning fits.
 */
export function fitFrames(frames: Uint8Array[], frameMs: number, maxBytes: number): { frames: Uint8Array[]; frameMs: number } | null {
  if (frames.length < MIN_FRAMES || frames.every((f) => sameBytes(f, frames[0]!))) return null;
  for (let step = 1; frames.length / step >= MIN_FRAMES; step *= 2) {
    const kept = frames.filter((_, i) => i % step === 0);
    if (kept.reduce((n, f) => n + f.length, 0) <= maxBytes) return { frames: kept, frameMs: frameMs * step };
  }
  return null;
}

// ── Recording ──────────────────────────────────────────────────────────────────────────────────────

const sourceSize = (s: ClipSource) => (s instanceof HTMLVideoElement ? { w: s.videoWidth, h: s.videoHeight } : { w: s.width, h: s.height });

/** Whether the source shows moving pixels worth recording right now. */
export function clipWorthy(s: ClipSource): boolean {
  if (s instanceof HTMLVideoElement) return !s.paused && !s.ended && s.readyState >= 2 && s.videoWidth > 0 && s.videoHeight > 0;
  return s.width > 0 && s.height > 0;
}

/**
 * Records the sources side by side for `durationMs` and returns an animated WebP data URL for each one that moved.
 * Each frame is drawn from inside an animation frame callback registered after the page's own, so a WebGL canvas
 * is read after the page drew it and before the browser clears it. Cross-origin (tainted) sources are skipped.
 */
export async function recordClips(win: Window, sources: ClipSource[], options: ClipOptions = {}, signal?: AbortSignal): Promise<Map<ClipSource, string>> {
  const o = { ...DEFAULTS, ...options };
  const doc = win.document;
  const out = new Map<ClipSource, string>();
  const tracks = sources.flatMap((source) => {
    const { w, h } = sourceSize(source);
    if (!w || !h) return [];
    const scale = Math.min(1, o.maxSide / Math.max(w, h));
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    return ctx ? [{ source, canvas, ctx, blobs: [] as Promise<Blob | null>[], failed: false }] : [];
  });
  if (!tracks.length) return out;
  const interval = 1000 / o.fps;
  let started = 0;
  await new Promise<void>((resolve) => {
    // rAF does not run in a hidden tab; the timer ends the recording anyway.
    const guard = setTimeout(resolve, o.durationMs + 1500);
    const done = () => (clearTimeout(guard), resolve());
    let last = -Infinity;
    const tick = (now: number) => {
      if (signal?.aborted) return done();
      if (!started) started = now;
      if (now - started >= o.durationMs) return done();
      if (now - last >= interval - 4) {
        last = now;
        for (const t of tracks) {
          if (t.failed) continue;
          try {
            t.ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
            t.ctx.drawImage(t.source, 0, 0, t.canvas.width, t.canvas.height);
            // toBlob copies the bitmap now and encodes off the main thread, so one canvas serves every frame.
            t.blobs.push(new Promise<Blob | null>((res) => t.canvas.toBlob(res, 'image/webp', o.quality)));
          } catch {
            t.failed = true; // Tainted: the page cannot read these pixels, and neither can the capture.
          }
        }
      }
      win.requestAnimationFrame(tick);
    };
    // Registered from inside a frame callback, so each tick runs after the page's own draw.
    win.requestAnimationFrame(() => win.requestAnimationFrame(tick));
  });
  const elapsed = Math.max(interval, (started ? performance.now() - started : o.durationMs));
  for (const t of tracks) {
    if (t.failed || !t.blobs.length) continue;
    const blobs = await Promise.all(t.blobs);
    if (blobs.some((b) => !b || b.type !== 'image/webp')) continue;
    const frames = await Promise.all(blobs.map(async (b) => new Uint8Array(await b!.arrayBuffer())));
    const fit = fitFrames(frames, Math.min(elapsed, o.durationMs) / frames.length, o.maxBytes);
    if (!fit) continue;
    const webp = animatedWebp(fit.frames, t.canvas.width, t.canvas.height, fit.frameMs);
    if (webp) out.set(t.source, await readBlob(new Blob([webp as BlobPart], { type: 'image/webp' })));
  }
  return out;
}
