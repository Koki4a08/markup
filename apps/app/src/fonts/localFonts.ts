export interface LocalFont {
  family: string;
  /** Face style name as the OS reports it, e.g. "Bold Italic". */
  style: string;
}

interface FontDataLike {
  family: string;
  style: string;
}

let cached: Promise<LocalFont[]> | null = null;

/** Fonts installed on this machine. Needs Chromium's permission-gated queryLocalFonts(); anything else is an empty list. Cached for the session. */
export function listLocalFonts(): Promise<LocalFont[]> {
  cached ??= (async () => {
    const query = (globalThis as { queryLocalFonts?: () => Promise<FontDataLike[]> }).queryLocalFonts;
    if (typeof query !== 'function') return [];
    try {
      const fonts = await query.call(globalThis);
      return fonts.map((f) => ({ family: f.family, style: f.style }));
    } catch {
      return [];
    }
  })();
  return cached;
}

/** Test hook: forget the cached list. */
export function resetLocalFontsCache(): void {
  cached = null;
}
