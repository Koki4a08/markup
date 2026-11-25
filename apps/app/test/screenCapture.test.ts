import { describe, expect, it } from 'vitest';
import { decodeWindowPixels, pixelHex } from '../src/desktop/screenCapture';

/** A capture reply as the Rust `capture_window` command sends it. */
function reply(width: number, height: number, rgba: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + rgba.length);
  const view = new DataView(buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  new Uint8Array(buffer, 8).set(rgba);
  return buffer;
}

describe('window capture', () => {
  const pixels = decodeWindowPixels(reply(2, 2, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 18, 52, 86, 255]));

  it('reads the size and the RGBA rows', () => {
    expect(pixels.width).toBe(2);
    expect(pixels.height).toBe(2);
    expect(pixels.data.length).toBe(16);
  });

  it('gives the hex of one pixel, rows top down', () => {
    expect(pixelHex(pixels, 0, 0)).toBe('#ff0000');
    expect(pixelHex(pixels, 1, 0)).toBe('#00ff00');
    expect(pixelHex(pixels, 0, 1)).toBe('#0000ff');
    expect(pixelHex(pixels, 1, 1)).toBe('#123456');
  });

  it('clamps a point outside the capture to its edge', () => {
    expect(pixelHex(pixels, -5, -5)).toBe('#ff0000');
    expect(pixelHex(pixels, 40, 40)).toBe('#123456');
  });

  it('rejects a reply whose size does not match its pixels', () => {
    expect(() => decodeWindowPixels(reply(3, 3, [0, 0, 0, 255]))).toThrow();
  });
});
