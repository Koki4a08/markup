/**
 * The shared view of a file: every visible artboard as an image, packed into one binary so a link
 * opens with one request. The website (markup-website/src/pages/share/bundle.ts) reads the same
 * format; change both together.
 *
 *   bytes 0-3   "MKS1"
 *   bytes 4-7   manifest length N, uint32 little-endian
 *   bytes 8..   manifest JSON (UTF-8, N bytes), then the images back to back
 *
 * Image offsets in the manifest count from the first byte after the manifest.
 */

export const BUNDLE_MAGIC = [0x4d, 0x4b, 0x53, 0x31] as const;

export interface ShareFrame {
  id: string;
  name: string;
  /** Position and size on the page, in CSS px. */
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'image/webp' | 'image/png';
  offset: number;
  length: number;
}

export interface SharePage {
  id: string;
  name: string;
  frames: ShareFrame[];
}

export interface ShareManifest {
  v: 1;
  name: string;
  createdAt: string;
  pages: SharePage[];
}

export interface FrameImage extends Omit<ShareFrame, 'offset' | 'length'> {
  bytes: Uint8Array;
}

export function encodeBundle(meta: { name: string; createdAt: string }, pages: { id: string; name: string; frames: FrameImage[] }[]): Uint8Array {
  let offset = 0;
  const images: Uint8Array[] = [];
  const manifest: ShareManifest = {
    v: 1,
    name: meta.name,
    createdAt: meta.createdAt,
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      frames: page.frames.map(({ bytes, ...frame }) => {
        const entry = { ...frame, offset, length: bytes.byteLength };
        offset += bytes.byteLength;
        images.push(bytes);
        return entry;
      }),
    })),
  };
  const head = new TextEncoder().encode(JSON.stringify(manifest));
  const out = new Uint8Array(8 + head.byteLength + offset);
  out.set(BUNDLE_MAGIC, 0);
  new DataView(out.buffer).setUint32(4, head.byteLength, true);
  out.set(head, 8);
  let at = 8 + head.byteLength;
  for (const image of images) {
    out.set(image, at);
    at += image.byteLength;
  }
  return out;
}

/** The manifest and where the images start; throws on anything that is not a bundle. */
export function decodeBundle(bytes: Uint8Array): { manifest: ShareManifest; dataStart: number } {
  if (bytes.byteLength < 8 || BUNDLE_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('Not a Markup preview.');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (8 + length > bytes.byteLength) throw new Error('Truncated preview.');
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as ShareManifest;
  if (manifest?.v !== 1 || !Array.isArray(manifest.pages)) throw new Error('Unknown preview version.');
  return { manifest, dataStart: 8 + length };
}

/** WebP when the browser could encode it; WebKit may hand back PNG for a WebP request. */
export function imageType(bytes: Uint8Array): ShareFrame['type'] {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? 'image/png' : 'image/webp';
}
