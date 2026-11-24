import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installDir, isScriptInstall, latestVersion, updateCommand } from '../src/update';
import { compareVersions, VERSION } from '../src/version';

describe('versions', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.4.0', '0.4.0')).toBe(0);
    expect(compareVersions('0.4', '0.4.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(0);
  });

  it('is a dev version when not built', () => {
    expect(VERSION).toBe('0.0.0-dev');
  });
});

describe('markup update', () => {
  it('only manages the binary in the install folder', () => {
    expect(installDir('/home/kg', {})).toBe(path.join('/home/kg', '.markup', 'bin'));
    expect(installDir('/home/kg', { MARKUP_INSTALL: '/opt/markup' })).toBe(path.join('/opt/markup', 'bin'));
    expect(isScriptInstall(path.join('/home/kg', '.markup', 'bin', 'markup'), '/home/kg', process.platform, {})).toBe(true);
    expect(isScriptInstall('/Applications/Markup.app/Contents/MacOS/markup', '/home/kg', 'darwin', {})).toBe(false);
    const winHome = 'C:\\Users\\KG';
    expect(isScriptInstall('c:\\users\\kg\\.markup\\bin\\markup.exe', winHome, 'win32', {})).toBe(process.platform === 'win32');
  });

  it('re-runs the install script without the setup step', () => {
    expect(updateCommand('linux')).toEqual({ command: 'sh', args: ['-c', '(curl -fsSL https://markup.here/install.sh || wget -qO- https://markup.here/install.sh) | MARKUP_NO_SETUP=1 sh'] });
    const win = updateCommand('win32');
    expect(win.command).toBe('powershell.exe');
    expect(win.args.at(-1)).toBe("$env:MARKUP_NO_SETUP='1'; irm https://markup.here/install.ps1 | iex");
  });

  it('reads the newest release tag, and gives up quietly offline', async () => {
    const ok = (async () => new Response(JSON.stringify({ tag_name: 'v0.5.0' }), { status: 200 })) as typeof fetch;
    expect(await latestVersion(ok)).toBe('0.5.0');
    expect(await latestVersion((async () => new Response('', { status: 403 })) as typeof fetch)).toBeNull();
    expect(await latestVersion((async () => Promise.reject(new Error('offline'))) as typeof fetch)).toBeNull();
  });
});
