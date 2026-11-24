/**
 * Colour model behind the colour picker: HSV in the picker's colour space (sRGB or Display P3), plus
 * the OKLCH, HSL, RGB and hex views it shows. Pure functions, so the maths is testable without a DOM.
 */
import { formatColor, parseColor } from './color';

export type Space = 'srgb' | 'display-p3';

/** A picked colour: hue 0–360, saturation and value 0–1, in the channels of `space`; alpha 0–1. */
export interface Picked {
  space: Space;
  h: number;
  s: number;
  v: number;
  a: number;
}

type Vec = [number, number, number];

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mul = (m: number[][], v: Vec): Vec => m.map((row) => row[0]! * v[0] + row[1]! * v[1] + row[2]! * v[2]) as Vec;
const round = (v: number, places: number) => {
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/* CSS Color 4 matrices (D65). */
const SRGB_TO_XYZ = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];
const XYZ_TO_SRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const P3_TO_XYZ = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];
const XYZ_TO_P3 = [
  [2.4934969119414254, -0.9313836179191239, -0.40271078445071684],
  [-0.8294889695615747, 1.7626640603183463, 0.023624685841943577],
  [0.03584583024378447, -0.07617238926804182, 0.9568845240076872],
];

/* sRGB and Display P3 share one transfer curve. */
const decode = (v: number) => (Math.abs(v) <= 0.04045 ? v / 12.92 : Math.sign(v) * ((Math.abs(v) + 0.055) / 1.055) ** 2.4);
const encode = (v: number) => (Math.abs(v) <= 0.0031308 ? 12.92 * v : Math.sign(v) * (1.055 * Math.abs(v) ** (1 / 2.4) - 0.055));

/** Encoded channels (0–1) of one space to linear sRGB, and back with the result clamped into the target gamut. */
function toLinearSrgb(space: Space, rgb: Vec): Vec {
  const lin = rgb.map(decode) as Vec;
  return space === 'srgb' ? lin : mul(XYZ_TO_SRGB, mul(P3_TO_XYZ, lin));
}
function fromLinearSrgb(space: Space, lin: Vec): Vec {
  const target = space === 'srgb' ? lin : mul(XYZ_TO_P3, mul(SRGB_TO_XYZ, lin));
  return target.map((c) => clamp(encode(c))) as Vec;
}

export function hsvToRgb(h: number, s: number, v: number): Vec {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/** RGB (0–1) to HSV; `hue` is kept when the colour is grey, so dragging to the edge never loses it. */
export function rgbToHsv([r, g, b]: Vec, hue = 0): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = hue;
  if (d > 1e-9) {
    if (max === r) h = 60 * (((g - b) / d + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h, s: max > 1e-9 ? d / max : 0, v: max };
}

export const rgbOf = (p: Picked): Vec => hsvToRgb(p.h, p.s, p.v);

/** A picked colour from channels in `space`; `hue` survives greys (see rgbToHsv). */
export function fromRgb(space: Space, rgb: Vec, a: number, hue?: number): Picked {
  return { space, ...rgbToHsv(rgb.map((c) => clamp(c)) as Vec, hue), a: clamp(a) };
}

/** The same colour in another space (clamped into sRGB when leaving the wider P3 gamut). */
export function convertSpace(p: Picked, space: Space): Picked {
  if (p.space === space) return p;
  return fromRgb(space, fromLinearSrgb(space, toLinearSrgb(p.space, rgbOf(p))), p.a, p.h);
}

const P3_FN = /^color\(\s*display-p3\s+([^/)]+?)\s*(?:\/\s*([^)]+?)\s*)?\)$/i;
const unit = (s: string) => (s === 'none' ? 0 : s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s));

/** Parses a CSS colour into the picker; color(display-p3 …) keeps its P3 channels, anything else is read as sRGB. */
export function parsePicked(css: string | null | undefined): Picked | null {
  if (!css) return null;
  const p3 = P3_FN.exec(css.trim());
  if (p3) {
    const parts = p3[1]!.split(/\s+/);
    if (parts.length !== 3) return null;
    const rgb = parts.map(unit) as Vec;
    const a = p3[2] === undefined ? 1 : unit(p3[2]);
    if ([...rgb, a].some(Number.isNaN)) return null;
    return fromRgb('display-p3', rgb, a);
  }
  const c = parseColor(css);
  return c ? fromRgb('srgb', [c.r / 255, c.g / 255, c.b / 255], c.a) : null;
}

/** CSS for a picked colour: #rrggbb / rgba() in sRGB (as the rest of the editor writes), color(display-p3 …) in P3. */
export function toCss(p: Picked): string {
  const rgb = rgbOf(p);
  const a = round(p.a, 3);
  if (p.space === 'srgb') {
    const [r, g, b] = rgb.map((c) => Math.round(c * 255)) as Vec;
    return formatColor({ r, g, b, a });
  }
  const body = rgb.map((c) => round(c, 4)).join(' ');
  return a >= 1 ? `color(display-p3 ${body})` : `color(display-p3 ${body} / ${a})`;
}

/** Channels as 0–255 integers in the picker's space. */
export const rgb255 = (p: Picked): Vec => rgbOf(p).map((c) => Math.round(c * 255)) as Vec;

const hex2 = (n: number) => n.toString(16).padStart(2, '0');
/** RRGGBB, upper case, of the channels in the picker's space. */
export const hexOf = (p: Picked) => rgb255(p).map(hex2).join('').toUpperCase();

/** RRGGBB / RGB / RRGGBBAA / RGBA (with or without #) to channels; null when it is not hex. */
export function parseHex(input: string): { rgb: Vec; a?: number } | null {
  const s = input.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(s) || ![3, 4, 6, 8].includes(s.length)) return null;
  const full = s.length <= 4 ? [...s].map((c) => c + c).join('') : s;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return { rgb: [n(0), n(2), n(4)], a: full.length === 8 ? n(6) : undefined };
}

export function toHsl(p: Picked): { h: number; s: number; l: number } {
  const l = p.v * (1 - p.s / 2);
  const s = l <= 0 || l >= 1 ? 0 : (p.v - l) / Math.min(l, 1 - l);
  return { h: p.h, s, l };
}

export function fromHsl(space: Space, h: number, s: number, l: number, a: number): Picked {
  const S = clamp(s);
  const L = clamp(l);
  const v = L + S * Math.min(L, 1 - L);
  return { space, h: ((h % 360) + 360) % 360, s: v <= 0 ? 0 : 2 * (1 - L / v), v, a: clamp(a) };
}

/** OKLCH of a picked colour: lightness 0–1, chroma (about 0–0.4), hue 0–360. */
export function toOklch(p: Picked): { l: number; c: number; h: number } {
  const [r, g, b] = toLinearSrgb(p.space, rgbOf(p));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  // Greys have no hue; keep 0 rather than a floating-point accident.
  const h = c < 2e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c: c < 2e-4 ? 0 : c, h };
}

/** A picked colour from OKLCH, clamped into the picker's gamut. */
export function fromOklch(space: Space, L: number, C: number, H: number, a: number, hue?: number): Picked {
  const rad = (H * Math.PI) / 180;
  const A = Math.max(0, C) * Math.cos(rad);
  const B = Math.max(0, C) * Math.sin(rad);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin: Vec = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return fromRgb(space, fromLinearSrgb(space, lin), a, hue);
}

/** Copyable CSS strings for each row of the picker. */
export function cssStrings(p: Picked): { oklch: string; hsl: string; rgb: string; hex: string } {
  const a = round(p.a, 3);
  const slash = a >= 1 ? '' : ` / ${round(a * 100, 1)}%`;
  const o = toOklch(p);
  const hsl = toHsl(p);
  const [r, g, b] = rgb255(p);
  return {
    oklch: `oklch(${round(o.l * 100, 1)}% ${round(o.c, 3)} ${round(o.h, 1)}${slash})`,
    hsl: `hsl(${round(hsl.h, 1)} ${round(hsl.s * 100, 1)}% ${round(hsl.l * 100, 1)}%${slash})`,
    rgb: p.space === 'srgb' ? `rgb(${r} ${g} ${b}${slash})` : toCss(p),
    hex: `#${hexOf(p)}${a >= 1 ? '' : hex2(Math.round(a * 255)).toUpperCase()}`,
  };
}

/** True when two picked colours render the same (8-bit channels, whole-percent alpha). */
export function sameColor(x: Picked, y: Picked): boolean {
  return x.space === y.space && hexOf(x) === hexOf(y) && Math.round(x.a * 100) === Math.round(y.a * 100);
}

export { round as roundTo };
