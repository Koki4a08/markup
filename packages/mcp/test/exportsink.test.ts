import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportDir, writeExports } from '../src/exportsink';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const file = (name: string, scale = '2x', format = 'png') => ({ nodeId: 'n1', name, format, scale, mimeType: 'image/png', data: b64(`${name}-${scale}`) });

const dirs: string[] = [];
afterEach(() => {
  delete process.env.MARKUP_EXPORT_DIR;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'markup-export-'));
  dirs.push(d);
  return d;
};

describe('export sink', () => {
  it('writes unique file names', () => {
    const dir = join(tempDir(), 'nested');
    const out = writeExports({ files: [file('Hero'), file('Hero'), file('Hero'), file('a/b:c*?"<>|\\d', '1x', 'jpg')] }, dir);
    expect(out.map((o) => basename(o.path!))).toEqual(['Hero@2x.png', 'Hero (2)@2x.png', 'Hero (3)@2x.png', 'a-b-c-------d@1x.jpg']);
    expect(out[0]).toMatchObject({ nodeId: 'n1', format: 'png' });
    expect(readFileSync(out[1]!.path!, 'utf8')).toBe('Hero-2x');
    // A second call does not overwrite earlier exports.
    const again = writeExports({ files: [file('Hero')] }, dir);
    expect(basename(again[0]!.path!)).toBe('Hero (4)@2x.png');
  });

  it('honours MARKUP_EXPORT_DIR', () => {
    const dir = join(tempDir(), 'custom');
    process.env.MARKUP_EXPORT_DIR = dir;
    expect(exportDir()).toBe(dir);
    const [written] = writeExports({ files: [file('Card')] });
    expect(written!.path).toBe(join(dir, 'Card@2x.png'));
    expect(existsSync(written!.path!)).toBe(true);
    delete process.env.MARKUP_EXPORT_DIR;
    expect(exportDir()).toBe(join(homedir(), 'Downloads', 'Markup'));
  });

  it('an empty layer name still gets a file name', () => {
    const [written] = writeExports({ files: [file('  ')] }, tempDir());
    expect(basename(written!.path!)).toBe('Untitled@2x.png');
  });
});

describe('export sink validation', () => {
  it('rejects a scale or format that would escape the export folder', () => {
    const dir = join(tempDir(), 'out');
    const evil = '1x/../../../AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/a';
    const out = writeExports({ files: [file('Hero', evil), file('Hero', '2x', 'png/../../x'), file('..', '2x'), file('Ok')] }, dir);
    expect(out[0]).toMatchObject({ nodeId: 'n1', error: expect.stringMatching(/scale/i) });
    expect(out[0]!.path).toBeUndefined();
    expect(out[1]).toMatchObject({ error: expect.stringMatching(/format/i) });
    expect(out[1]!.path).toBeUndefined();
    // A name of ".." is sanitised to a plain file name inside dir.
    expect(out[2]!.error).toBeUndefined();
    expect(out[2]!.path!.startsWith(dir)).toBe(true);
    expect(basename(out[3]!.path!)).toBe('Ok@2x.png');
    expect(existsSync(join(dir, '..', '..', '..', 'AppData'))).toBe(false);
  });
});
