import { inTauri } from '../export/clipboard';

/** Pixels of the app window, as the eyedropper samples them (physical pixels, RGBA rows). */
export interface WindowPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * The Windows desktop app samples colours from a capture of its own window: WebView2 exposes the
 * EyeDropper API but rejects every `open()` at once, with the same AbortError as a cancel.
 */
export const canCaptureWindow = (): boolean => inTauri() && /Windows/i.test(navigator.userAgent);

export async function captureWindow(): Promise<WindowPixels> {
  const { invoke } = await import('@tauri-apps/api/core');
  return decodeWindowPixels(await invoke<ArrayBuffer>('capture_window'));
}

/** Reads the `capture_window` reply: width and height (u32, little endian), then RGBA rows. */
export function decodeWindowPixels(buffer: ArrayBuffer): WindowPixels {
  const head = new DataView(buffer, 0, 8);
  const width = head.getUint32(0, true);
  const height = head.getUint32(4, true);
  const data = new Uint8ClampedArray(buffer, 8);
  if (!width || !height || data.length !== width * height * 4) throw new Error('Unexpected window capture');
  return { width, height, data };
}

/** `#rrggbb` of one pixel, with the point clamped into the capture. */
export function pixelHex(pixels: WindowPixels, x: number, y: number): string {
  const px = Math.min(pixels.width - 1, Math.max(0, Math.round(x)));
  const py = Math.min(pixels.height - 1, Math.max(0, Math.round(y)));
  const i = (py * pixels.width + px) * 4;
  return `#${[0, 1, 2].map((c) => (pixels.data[i + c] ?? 0).toString(16).padStart(2, '0')).join('')}`;
}
