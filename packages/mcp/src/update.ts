import path from 'node:path';

export const SITE = 'https://markup.here';
export const REPO = 'Koki4a08/markup';

/** The one-line installers served by the website (markup-website/public). */
export const INSTALL_COMMANDS = {
  unix: `curl -fsSL ${SITE}/install.sh | sh`,
  windows: `irm ${SITE}/install.ps1 | iex`,
} as const;

export const installCommand = (platform: NodeJS.Platform) => (platform === 'win32' ? INSTALL_COMMANDS.windows : INSTALL_COMMANDS.unix);

/** Where the install scripts put the binary: $MARKUP_INSTALL/bin, by default ~/.markup/bin. */
export function installDir(home: string, env: Record<string, string | undefined> = process.env): string {
  return path.join(env.MARKUP_INSTALL || path.join(home, '.markup'), 'bin');
}

/** True when this binary is the one the install script manages, so `markup update` may replace it. */
export function isScriptInstall(execPath: string, home: string, platform: NodeJS.Platform, env: Record<string, string | undefined> = process.env): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (s: string) => (platform === 'win32' ? p.normalize(s).toLowerCase() : p.normalize(s));
  return norm(p.dirname(execPath)) === norm(installDir(home, env));
}

/** Newest released version from GitHub, without the "v", or null when offline or rate-limited. */
export async function latestVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'markup-cli' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    return typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

/** The command that re-runs the installer without the agent setup step, for `markup update`. */
export function updateCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$env:MARKUP_NO_SETUP='1'; ${INSTALL_COMMANDS.windows}`] };
  }
  const url = `${SITE}/install.sh`;
  return { command: 'sh', args: ['-c', `(curl -fsSL ${url} || wget -qO- ${url}) | MARKUP_NO_SETUP=1 sh`] };
}
