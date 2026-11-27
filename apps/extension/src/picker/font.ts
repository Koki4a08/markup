import geistLatin from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2';

/**
 * Geist for the picker chrome, the same face as the editor and markup.here. It is bundled into the
 * content script and registered from bytes through the FontFace API: no request the page's CSP could
 * block, and no @font-face rule in the page's stylesheets, so captures never pick it up. Shadow roots
 * ignore their own @font-face rules, which is why it lives on the document's font set.
 */
export const UI_FONT_FAMILY = 'Markup UI Geist';

export function ensureUiFont(doc: Document): void {
  const fonts = doc.fonts as FontFaceSet | undefined;
  const FontFaceCtor = doc.defaultView?.FontFace;
  if (!fonts || !FontFaceCtor || !geistLatin.byteLength) return;
  for (const face of fonts) if (face.family.replace(/["']/g, '') === UI_FONT_FAMILY) return;
  try {
    const face = new FontFaceCtor(UI_FONT_FAMILY, geistLatin, {
      weight: '100 900',
      style: 'normal',
      display: 'swap',
      unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    });
    fonts.add(face);
  } catch {
    // The system fallback in the font stack takes over.
  }
}
