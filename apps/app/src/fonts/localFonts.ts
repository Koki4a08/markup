export interface LocalFont {
  family: string;
  /** Face style name as the OS reports it, e.g. "Bold Italic". */
  style: string;
}

interface FontDataLike {
  family: string;
  style: string;
}

type Query = () => Promise<FontDataLike[]>;

let cached: LocalFont[] | null = null;

const queryFn = (): Query | undefined => {
  const q = (globalThis as { queryLocalFonts?: Query }).queryLocalFonts;
  return typeof q === 'function' ? q : undefined;
};

/** Whether the user already allowed local fonts. Never prompts; an unsupported permission name counts as not granted. */
export async function localFontsGranted(): Promise<boolean> {
  if (!queryFn()) return false;
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' as PermissionName });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

/** Local fonts known so far, without any query or prompt. */
export const knownLocalFonts = (): LocalFont[] => cached ?? [];

async function read(): Promise<LocalFont[]> {
  const fonts = await queryFn()!.call(globalThis);
  cached = fonts.map((f) => ({ family: f.family, style: f.style }));
  return cached;
}

/** Installed fonts, only when permission is already granted; otherwise []. Only a successful read is cached, so a later grant works. */
export async function listLocalFonts(): Promise<LocalFont[]> {
  if (cached) return cached;
  if (!(await localFontsGranted())) return [];
  try {
    return await read();
  } catch {
    return [];
  }
}

/** Asks the browser for access (may prompt); call from a user gesture. Resolves whether local fonts are now available. */
export async function requestLocalFonts(): Promise<boolean> {
  if (!queryFn()) return false;
  try {
    await read();
    return true;
  } catch {
    return false;
  }
}

/** Test hook: forget the cached list. */
export function resetLocalFontsCache(): void {
  cached = null;
}
