import { MarkupError } from '@markup/doc';
import { familyInfo } from '../fonts/fontLoader';
import { listLocalFonts, localFontsGranted } from '../fonts/localFonts';

export const LOCAL_FONTS_NOTE = 'not granted - the user can allow local fonts from the Text panel';

/** get_font_family_info: which families exist locally or on Google Fonts, with their style groups. */
export async function runFontTool(params: Record<string, unknown>) {
  const names = params.familyNames;
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    throw new MarkupError('INVALID_ARGUMENT', 'familyNames must be an array of font family names.');
  }
  const local = await listLocalFonts();
  const families = familyInfo(names as string[], local);
  return (await localFontsGranted()) ? { families } : { families, localFonts: LOCAL_FONTS_NOTE };
}
