/** Colour parsing for the panels: CSS colour strings to RGBA and back, without a canvas (tests run in jsdom). */

export interface RGBA {
  /** 0–255 */
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  navy: '#000080',
  teal: '#008080',
  maroon: '#800000',
  olive: '#808000',
  lime: '#00ff00',
  aqua: '#00ffff',
  cyan: '#00ffff',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  gold: '#ffd700',
  indigo: '#4b0082',
  violet: '#ee82ee',
  coral: '#ff7f50',
  salmon: '#fa8072',
  tomato: '#ff6347',
  crimson: '#dc143c',
  beige: '#f5f5dc',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  tan: '#d2b48c',
  whitesmoke: '#f5f5f5',
  gainsboro: '#dcdcdc',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  dimgray: '#696969',
  dimgrey: '#696969',
  slategray: '#708090',
  slategrey: '#708090',
  transparent: '#00000000',
};

/**
 * Colours inside a style value: hex, rgb()/hsl() (one level of nesting is enough for real values),
 * var() references and named colours.
 */
export const COLOR_IN_VALUE = new RegExp(
  `#[0-9a-f]{3,8}(?![0-9a-z])|(?<![\\w-])(?:rgba?|hsla?|lab|lch|oklab|oklch|color)\\([^()]*\\)|var\\(\\s*--[\\w-]+\\s*(?:,(?:[^()]|\\([^()]*\\))*)?\\)|\\b(?:${Object.keys(NAMED).join('|')})\\b`,
  'gi',
);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function channel(s: string): number {
  return s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s);
}

function alpha(s: string | undefined): number {
  if (s === undefined) return 1;
  return s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
}

function hue(s: string): number {
  const v = parseFloat(s);
  if (s.endsWith('turn')) return v * 360;
  if (s.endsWith('rad')) return (v * 180) / Math.PI;
  return v;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

type Vec = [number, number, number];
const mul = (m: number[][], v: Vec): Vec => m.map((row) => row[0]! * v[0] + row[1]! * v[1] + row[2]! * v[2]) as Vec;

/** CSS Color 4 matrices: D50→D65 (Bradford), XYZ D65→linear sRGB, linear Display P3→XYZ D65. */
const D50_TO_D65 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
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

const encode = (v: number) => (Math.abs(v) <= 0.0031308 ? 12.92 * v : Math.sign(v) * (1.055 * Math.abs(v) ** (1 / 2.4) - 0.055));
const decode = (v: number) => (Math.abs(v) <= 0.04045 ? v / 12.92 : Math.sign(v) * ((Math.abs(v) + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: Vec): Vec => v.map((c) => encode(c) * 255) as Vec;

function labToRgb(l: number, a: number, b: number): Vec {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const xyz: Vec = [(fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k) * 0.96422, l > k * e ? fy ** 3 : l / k, (fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k) * 0.82521];
  return fromLinear(mul(XYZ_TO_SRGB, mul(D50_TO_D65, xyz)));
}

function oklabToRgb(l: number, a: number, b: number): Vec {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return fromLinear([4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_]);
}

/** A number, or a percentage scaled so 100% = `full`; `none` is 0. */
const num = (s: string, full = 100) => (s === 'none' ? 0 : s.endsWith('%') ? (parseFloat(s) / 100) * full : parseFloat(s));

/** Parses a CSS colour; null for anything that is not a plain colour (var(), gradients, currentColor). */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  const named = NAMED[s];
  if (named) return parseColor(named);
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  const fn = /^(rgba?|hsla?|lab|lch|oklab|oklch|color)\((.*)\)$/.exec(s);
  if (!fn) return null;
  const [body, slashAlpha] = fn[2]!.split('/').map((p) => p.trim());
  let parts = body!.split(/[\s,]+/).filter(Boolean);
  let space = fn[1]!;
  if (space === 'color') {
    space = parts[0] ?? '';
    parts = parts.slice(1);
  }
  if (parts.length < 3) return null;
  const a = clamp(alpha(slashAlpha ?? parts[3]), 0, 1);
  const [p0, p1, p2] = parts as [string, string, string];
  let rgb: Vec;
  if (space.startsWith('rgb')) rgb = [channel(p0), channel(p1), channel(p2)];
  else if (space.startsWith('hsl')) rgb = hslToRgb(hue(p0), clamp(parseFloat(p1) / 100, 0, 1), clamp(parseFloat(p2) / 100, 0, 1));
  else if (space === 'lab') rgb = labToRgb(num(p0), num(p1, 125), num(p2, 125));
  else if (space === 'lch') {
    const c = num(p1, 150);
    const h = (hue(p2) * Math.PI) / 180;
    rgb = labToRgb(num(p0), c * Math.cos(h), c * Math.sin(h));
  } else if (space === 'oklab') rgb = oklabToRgb(num(p0, 1), num(p1, 0.4), num(p2, 0.4));
  else if (space === 'oklch') {
    const c = num(p1, 0.4);
    const h = (hue(p2) * Math.PI) / 180;
    rgb = oklabToRgb(num(p0, 1), c * Math.cos(h), c * Math.sin(h));
  } else if (space === 'srgb') rgb = [num(p0, 1) * 255, num(p1, 1) * 255, num(p2, 1) * 255];
  else if (space === 'srgb-linear') rgb = fromLinear([num(p0, 1), num(p1, 1), num(p2, 1)]);
  else if (space === 'display-p3') rgb = fromLinear(mul(XYZ_TO_SRGB, mul(P3_TO_XYZ, [decode(num(p0, 1)), decode(num(p1, 1)), decode(num(p2, 1))])));
  else return null;
  if ([...rgb, a].some(Number.isNaN)) return null;
  const [r, g, b] = rgb.map((v) => Math.round(clamp(v, 0, 255))) as Vec;
  return { r, g, b, a };
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** RRGGBB, upper case and without '#', as design tools show it. */
export const hexLabel = (c: RGBA) => `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase();

/** #rrggbb for opaque colours, rgba() otherwise. */
export function formatColor(c: RGBA): string {
  if (c.a >= 1) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(c.a * 1000) / 1000})`;
}

export const colorKey = (c: RGBA) => `${c.r},${c.g},${c.b},${Math.round(c.a * 100)}`;

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(c: RGBA): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio between two opaque colours, 1 to 21. */
export function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
