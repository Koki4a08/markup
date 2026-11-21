export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;

export type ImageResult = { dataUrl: string } | { error: string };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function isTrustedSender(sender: { id?: string; tab?: unknown } | undefined, extensionId: string): boolean {
  return !!sender && sender.id === extensionId && !!sender.tab;
}

/** Native base64 (Uint8Array.prototype.toBase64) where the engine has it, else btoa over byte chunks. */
export function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function fetchImage(
  url: string,
  fetchImpl: FetchLike = fetch,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<ImageResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'invalid url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'unsupported url scheme' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(parsed.href, { credentials: 'omit', signal: controller.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!type.startsWith('image/')) return { error: 'not an image' };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      void res.body?.cancel().catch(() => {});
      return { error: 'image too large' };
    }
    if (!res.body) return { error: 'empty response' };

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        void reader.cancel().catch(() => {});
        return { error: 'image too large' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { dataUrl: `data:${type};base64,${base64(bytes)}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
