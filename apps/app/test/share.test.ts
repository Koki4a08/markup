import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@markup/doc';
import { createShareSync, expiryDate, newShareToken, sha256Hex, shareUrl, type ShareApi, type ShareLinkRow } from '../src/cloud/share';
import { decodeBundle, encodeBundle, imageType } from '../src/cloud/shareBundle';
import { previewRatio } from '../src/cloud/sharePreview';
import { CLOUD_ORIGIN } from '../src/cloud/sync';
import { memoryWorkspace } from './memoryWorkspace';

const YOU: Actor = { id: 'local-user', kind: 'human', name: 'You' };
const SITE = 'https://markup.here';
const NOW = Date.parse('2026-11-26T12:00:00Z');

/** Share rows in memory, keyed like the database: links point at cloud rows, not local ids. */
function fakeServer(opts: { inCloud?: boolean; uploadFails?: boolean } = {}) {
  const rows = new Map<string, string>();
  const links: (ShareLinkRow & { rowId: string; tokenHash: string })[] = [];
  const previews = new Map<string, Uint8Array>();
  let n = 0;
  const api = {
    fileRow: vi.fn(async (fileId: string) => (opts.inCloud === false ? null : (rows.get(fileId) ?? (rows.set(fileId, `row-${fileId}`), `row-${fileId}`)))),
    links: vi.fn(async (rowId: string) => links.filter((l) => l.rowId === rowId)),
    sharedFiles: vi.fn(async () => [...rows].filter(([, rowId]) => links.some((l) => l.rowId === rowId && !l.revokedAt)).map(([fileId]) => fileId)),
    previewAt: vi.fn(async () => null),
    create: vi.fn(async (rowId: string, tokenHash: string, expiresAt: string | null) => {
      const link = { id: `link-${++n}`, rowId, tokenHash, createdAt: new Date(NOW + n).toISOString(), expiresAt, revokedAt: null };
      links.push(link);
      return { id: link.id, createdAt: link.createdAt, expiresAt, revokedAt: null };
    }),
    revoke: vi.fn(async (linkId: string) => {
      links.find((l) => l.id === linkId)!.revokedAt = new Date(NOW).toISOString();
    }),
    uploadPreview: vi.fn(async (fileId: string, bytes: Uint8Array) => {
      if (opts.uploadFails) throw new Error('Your cloud storage is full.');
      previews.set(fileId, bytes);
      return new Date(NOW).toISOString();
    }),
    removePreview: vi.fn(async (fileId: string) => void previews.delete(fileId)),
  } satisfies ShareApi;
  return { api, links, previews };
}

async function setup(opts: { inCloud?: boolean; uploadFails?: boolean; storage?: Map<string, string> } = {}) {
  const ws = memoryWorkspace();
  const server = fakeServer(opts);
  const storage = opts.storage ?? new Map<string, string>();
  const render = vi.fn(async () => new Uint8Array([0x4d, 0x4b, 0x53, 0x31, 0, 0, 0, 0]));
  const created = await ws.workspace.createFile({ name: 'Landing' });
  const doc = await ws.workspace.open(created.id);
  const share = createShareSync({
    api: server.api,
    workspace: ws.workspace,
    userId: 'u1',
    siteUrl: SITE,
    render,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
    debounceMs: 0,
    now: () => NOW,
  });
  return { ...ws, server, share, render, storage, fileId: created.id, doc };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('share links', () => {
  it('makes a view-only link, stores only the token’s hash, and renders the shared view', async () => {
    const s = await setup();
    const url = await s.share.create(s.fileId, '7d');
    const token = url.slice(`${SITE}/s/#`.length);
    expect(url.startsWith(`${SITE}/s/#`)).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const link = s.server.links[0]!;
    expect(link.tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(s.server.api.create.mock.calls)).not.toContain(token);
    expect(link.expiresAt).toBe(expiryDate('7d', NOW));
    expect(s.render).toHaveBeenCalledTimes(1);
    expect(s.server.previews.has(s.fileId)).toBe(true);
    const state = s.share.get(s.fileId);
    expect(state.links).toHaveLength(1);
    expect(state.links[0]!.url).toBe(url);
    expect(state.preview).toBe('idle');
  });

  it('can copy the link again on this device after a restart, not elsewhere', async () => {
    const storage = new Map<string, string>();
    const first = await setup({ storage });
    const url = await first.share.create(first.fileId, 'never');
    first.share.dispose();

    const again = createShareSync({
      api: first.server.api,
      workspace: first.workspace,
      userId: 'u1',
      siteUrl: SITE,
      render: first.render,
      storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
      now: () => NOW,
    });
    await again.load(first.fileId);
    expect(again.get(first.fileId).links[0]!.url).toBe(url);

    const elsewhere = createShareSync({ api: first.server.api, workspace: first.workspace, userId: 'u1', siteUrl: SITE, render: first.render, storage: null, now: () => NOW });
    await elsewhere.load(first.fileId);
    expect(elsewhere.get(first.fileId).links[0]!.url).toBeNull();
  });

  it('re-renders the shared view after edits, but not after merges from the cloud', async () => {
    const s = await setup();
    await s.share.create(s.fileId, 'never');
    s.render.mockClear();
    s.doc.createPage(YOU, { name: 'Second' });
    await settle();
    expect(s.render).toHaveBeenCalledTimes(1);

    s.render.mockClear();
    s.doc.ydoc.transact(() => s.doc.meta.set('note', 'from another device'), CLOUD_ORIGIN);
    await settle();
    expect(s.render).not.toHaveBeenCalled();
  });

  it('leaves files without a link alone', async () => {
    const s = await setup();
    s.doc.createPage(YOU, { name: 'Second' });
    await settle();
    expect(s.render).not.toHaveBeenCalled();
  });

  it('turning off the last link stops updates and frees the shared view', async () => {
    const s = await setup();
    await s.share.create(s.fileId, 'never');
    const id = s.share.get(s.fileId).links[0]!.id;
    await s.share.revoke(s.fileId, id);
    expect(s.server.links[0]!.revokedAt).not.toBeNull();
    expect(s.share.get(s.fileId).links).toHaveLength(0);
    expect(s.server.api.removePreview).toHaveBeenCalledWith(s.fileId);
    s.render.mockClear();
    s.doc.createPage(YOU, { name: 'Second' });
    await settle();
    expect(s.render).not.toHaveBeenCalled();
  });

  it('keeps the link when the shared view fails, and says why', async () => {
    const s = await setup({ uploadFails: true });
    await s.share.create(s.fileId, 'never');
    const state = s.share.get(s.fileId);
    expect(state.links).toHaveLength(1);
    expect(state.preview).toBe('failed');
    expect(state.error).toContain('storage is full');
  });

  it('needs the file in the cloud', async () => {
    const s = await setup({ inCloud: false });
    await expect(s.share.create(s.fileId, 'never')).rejects.toMatchObject({ code: 'not_in_cloud' });
    expect(s.server.api.create).not.toHaveBeenCalled();
  });

  it('lists only links that are on and not expired', async () => {
    const s = await setup();
    await s.share.create(s.fileId, 'never');
    s.server.links.push({ id: 'old', rowId: `row-${s.fileId}`, tokenHash: 'x', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-02-01T00:00:00Z', revokedAt: null });
    s.server.links.push({ id: 'off', rowId: `row-${s.fileId}`, tokenHash: 'y', createdAt: '2026-01-01T00:00:00Z', expiresAt: null, revokedAt: '2026-01-02T00:00:00Z' });
    await s.share.load(s.fileId);
    expect(s.share.get(s.fileId).links.map((l) => l.id)).toEqual(['link-1']);
  });
});

describe('share helpers', () => {
  it('builds links with the token after #, so it never reaches a server log', () => {
    expect(shareUrl('https://markup.here/', 'abc')).toBe('https://markup.here/s/#abc');
    const a = newShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newShareToken()).not.toBe(a);
  });

  it('expiry dates', () => {
    expect(expiryDate('never', NOW)).toBeNull();
    expect(expiryDate('30d', NOW)).toBe('2026-12-26T12:00:00.000Z');
  });

  it('bundles round-trip', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 3]);
    const bytes = encodeBundle({ name: 'Landing', createdAt: '2026-11-26T12:00:00Z' }, [
      { id: 'p1', name: 'Page 1', frames: [{ id: 'a', name: 'Home', x: 0, y: 0, width: 100, height: 50, type: imageType(png), bytes: png }] },
      { id: 'p2', name: 'Page 2', frames: [{ id: 'b', name: 'About', x: 200, y: 10, width: 30, height: 30, type: imageType(webp), bytes: webp }] },
    ]);
    const { manifest, dataStart } = decodeBundle(bytes);
    expect(manifest.name).toBe('Landing');
    const [a] = manifest.pages[0]!.frames;
    const [b] = manifest.pages[1]!.frames;
    expect(a!.type).toBe('image/png');
    expect(b!.type).toBe('image/webp');
    expect(bytes.subarray(dataStart + a!.offset, dataStart + a!.offset + a!.length)).toEqual(png);
    expect(bytes.subarray(dataStart + b!.offset, dataStart + b!.offset + b!.length)).toEqual(webp);
    expect(() => decodeBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });

  it('keeps big artboards within a sane image size', () => {
    expect(previewRatio(1440, 900)).toBe(2);
    expect(previewRatio(1440, 20000)).toBeLessThan(1);
    expect(Math.round(1440 * previewRatio(1440, 20000)) * Math.round(20000 * previewRatio(1440, 20000))).toBeLessThanOrEqual(12_100_000);
  });
});
