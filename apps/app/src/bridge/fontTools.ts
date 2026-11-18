import { MarkupError } from '@markup/doc';
import { familyInfo } from '../fonts/fontLoader';
import { listLocalFonts } from '../fonts/localFonts';

/** get_font_family_info: which families exist locally or on Google Fonts, with their style groups. */
export async function runFontTool(params: Record<string, unknown>) {
  const names = params.familyNames;
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    throw new MarkupError('INVALID_ARGUMENT', 'familyNames must be an array of font family names.');
  }
  return { families: familyInfo(names as string[], await listLocalFonts()) };
}
