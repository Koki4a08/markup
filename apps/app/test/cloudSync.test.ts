import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Actor } from '@markup/doc';
import { CloudError, createCloudSync, type CloudApi, type LocalFiles } from '../src/cloud/sync';
import { memoryWorkspace } from './memoryWorkspace';

const YOU: Actor = { id: 'local-user', kind: 'human', name: 'You' };

/** A cloud in memory: rows with a version, and the stored states. */
function fakeCloud(opts: { full?: boolean } = {}) {
  const rows = new Map<string, { name: string; version: number; state: Uint8Array | null }>();
  let clock = 0;
  const api = {
    list: vi.fn(async () => [...rows].map(([fileId, r]) => ({ fileId, name: r.name, updatedAt: String(r.version) }))),
    add: vi.fn(async (fileId: string, name: string) => void rows.set(fileId, { name, version: ++clock, state: null })),
    remove: vi.fn(async (fileId: string) => void rows.delete(fileId)),
    rename: vi.fn(async (fileId: string, name: string) => void (rows.get(fileId)!.name = name)),
    version: vi.fn(async (fileId: string) => (rows.has(fileId) ? String(rows.get(fileId)!.version) : null)),
    download: vi.fn(async (fileId: string) => rows.get(fileId)?.state ?? null),
    upload: vi.fn(async (fileId: string, state: Uint8Array) => {
      if (opts.full) throw new CloudError('quota_exceeded', 'full');
      const row = rows.get(fileId);
      if (!row) throw new CloudError('not_in_cloud', 'gone');
      row.state = state;
      row.version = ++clock;
      return String(row.version);
    }),
    usage: vi.fn(async () => ({ used: 10, quota: 100 })),
  } satisfies CloudApi;
  /** Another device edits the cloud copy. */
  const editElsewhere = (fileId: string, change: (doc: Y.Doc) => void) => {
    const row = rows.get(fileId)!;
    const doc = new Y.Doc();
    if (row.state) Y.applyUpdate(doc, row.state);
    change(doc);
    row.state = Y.encodeStateAsUpdate(doc);
    row.version = ++clock;
  };
  return { api, rows, editElsewhere };
}

function fakeLocal() {
  const files = new Map<string, Uint8Array>();
  const local: LocalFiles = {
    read: vi.fn(async (id: string) => files.get(id) ?? null),
    merge: vi.fn(async (id: string, state: Uint8Array) => {
      const doc = new Y.Doc();
      const known = files.get(id);
      if (known) Y.applyUpdate(doc, known);
      Y.applyUpdate(doc, state);
      files.set(id, Y.encodeStateAsUpdate(doc));
    }),
  };
  return { local, files };
}

async function setup(opts: { full?: boolean } = {}) {
  const ws = memoryWorkspace();
  const cloud = fakeCloud(opts);
  const { local, files } = fakeLocal();
  const sync = createCloudSync({ api: cloud.api, workspace: ws.workspace, local, userId: 'u1', storage: null, debounceMs: 0 });
  const created = await ws.workspace.createFile({ name: 'Landing' });
  const doc = await ws.workspace.open(created.id);
  return { ...ws, cloud, local, files, sync, fileId: created.id, doc };
}

const tokens = (doc: Y.Doc) => doc.getArray<string>('tokens').toArray();

describe('cloud sync', () => {
  it('Keep in cloud uploads the file and marks it saved', async () => {
    const s = await setup();
    await s.sync.enable(s.fileId);
    expect(s.cloud.api.add).toHaveBeenCalledWith(s.fileId, 'Landing');
    expect(s.cloud.rows.get(s.fileId)!.state).not.toBeNull();
    expect(s.sync.isInCloud(s.fileId)).toBe(true);
    expect(s.sync.status(s.fileId)).toBe('synced');
  });

  it('uploads edits after they settle, and leaves files not in the cloud alone', async () => {
    const s = await setup();
    const other = await s.workspace.createFile({ name: 'Local only' });
    const otherDoc = await s.workspace.open(other.id);
    await s.sync.enable(s.fileId);
    s.cloud.api.upload.mockClear();
    s.doc.ydoc.transact(() => s.doc.ydoc.getArray('tokens').push(['brand']), YOU);
    otherDoc.ydoc.transact(() => otherDoc.ydoc.getArray('tokens').push(['private']), YOU);
    await vi.waitFor(() => expect(s.cloud.api.upload).toHaveBeenCalledTimes(1));
    const saved = new Y.Doc();
    Y.applyUpdate(saved, s.cloud.rows.get(s.fileId)!.state!);
    expect(tokens(saved)).toEqual(['brand']);
    expect(s.cloud.api.upload.mock.calls.every(([id]) => id === s.fileId)).toBe(true);
  });

  it('merges another device’s changes before uploading, so both survive', async () => {
    const s = await setup();
    await s.sync.enable(s.fileId);
    s.cloud.editElsewhere(s.fileId, (d) => d.getArray('tokens').push(['from laptop']));
    s.doc.ydoc.transact(() => s.doc.ydoc.getArray('tokens').push(['from desktop']), YOU);
    await vi.waitFor(() => expect(s.cloud.api.upload).toHaveBeenCalledTimes(2));
    expect(tokens(s.doc.ydoc).sort()).toEqual(['from desktop', 'from laptop']);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, s.cloud.rows.get(s.fileId)!.state!);
    expect(tokens(saved).sort()).toEqual(['from desktop', 'from laptop']);
  });

  it('pulling from the cloud does not count as a local change', async () => {
    const s = await setup();
    await s.sync.enable(s.fileId);
    s.cloud.api.upload.mockClear();
    s.cloud.editElsewhere(s.fileId, (d) => d.getArray('tokens').push(['remote']));
    s.workspace.close(s.fileId);
    const doc = await s.workspace.open(s.fileId);
    await vi.waitFor(() => expect(tokens(doc.ydoc)).toEqual(['remote']));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.cloud.api.upload).not.toHaveBeenCalled();
  });

  it('brings in files that are only in the cloud', async () => {
    const s = await setup();
    const elsewhere = new Y.Doc();
    elsewhere.getMap('meta').set('fileId', 'remoteFile1');
    elsewhere.getArray('tokens').push(['hello']);
    s.cloud.rows.set('remoteFile1', { name: 'From laptop', version: 50, state: Y.encodeStateAsUpdate(elsewhere) });
    await s.sync.refresh();
    expect(s.local.merge).toHaveBeenCalledWith('remoteFile1', expect.any(Uint8Array));
    expect(s.library.get('remoteFile1')?.name).toBe('From laptop');
    expect(s.sync.isInCloud('remoteFile1')).toBe(true);
    expect(s.sync.usage()).toEqual({ used: 10, quota: 100 });
  });

  it('keeps editing locally when the cloud is full, and says so', async () => {
    const s = await setup({ full: true });
    await s.sync.enable(s.fileId);
    expect(s.sync.status(s.fileId)).toBe('full');
    s.doc.ydoc.transact(() => s.doc.ydoc.getArray('tokens').push(['still works']), YOU);
    expect(tokens(s.doc.ydoc)).toEqual(['still works']);
  });

  it('Remove from cloud deletes the cloud copy only', async () => {
    const s = await setup();
    await s.sync.enable(s.fileId);
    await s.sync.disable(s.fileId);
    expect(s.cloud.rows.has(s.fileId)).toBe(false);
    expect(s.sync.isInCloud(s.fileId)).toBe(false);
    expect(s.library.get(s.fileId)).toBeTruthy();
  });

  it('notices a file removed from the cloud on another device', async () => {
    const s = await setup();
    await s.sync.enable(s.fileId);
    s.cloud.rows.delete(s.fileId);
    s.doc.ydoc.transact(() => s.doc.ydoc.getArray('tokens').push(['x']), YOU);
    await vi.waitFor(() => expect(s.sync.isInCloud(s.fileId)).toBe(false));
    expect(s.sync.status(s.fileId)).toBeNull();
  });

  it('follows a rename made on the website, and does not undo it on the next upload', async () => {
    const s = await setup();
    await s.sync.enable(s.fileId);
    s.cloud.rows.get(s.fileId)!.name = 'Renamed on the site';
    await s.sync.refresh();
    expect(s.library.get(s.fileId)?.name).toBe('Renamed on the site');
    s.cloud.api.rename.mockClear();
    s.doc.ydoc.transact(() => s.doc.ydoc.getArray('tokens').push(['edit']), YOU);
    await vi.waitFor(() => expect(s.cloud.api.upload).toHaveBeenCalledTimes(2));
    expect(s.cloud.api.rename).not.toHaveBeenCalled();
    expect(s.cloud.rows.get(s.fileId)!.name).toBe('Renamed on the site');
  });

  it('sends a rename made in the app to the cloud', async () => {
    const s = await setup();
    await s.sync.enable(s.fileId);
    s.workspace.rename(s.fileId, 'Renamed in the app');
    s.doc.ydoc.transact(() => s.doc.ydoc.getArray('tokens').push(['edit']), YOU);
    await vi.waitFor(() => expect(s.cloud.rows.get(s.fileId)!.name).toBe('Renamed in the app'));
  });

  it('stops syncing a file archived on the website, and keeps the local copy', async () => {
    const s = await setup();
    await s.sync.enable(s.fileId);
    // The website's Archive is a soft delete: the row leaves the live list.
    const row = s.cloud.rows.get(s.fileId)!;
    s.cloud.rows.delete(s.fileId);
    await s.sync.refresh();
    expect(s.sync.isInCloud(s.fileId)).toBe(false);
    expect(s.library.get(s.fileId)).toBeTruthy();
    s.cloud.rows.set(s.fileId, row); // Restored on the website.
    await s.sync.refresh();
    expect(s.sync.isInCloud(s.fileId)).toBe(true);
  });

  it('remembers unsaved changes across runs and uploads them on the next start', async () => {
    const storage = new Map<string, string>();
    const backing = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) };
    const ws = memoryWorkspace();
    const cloud = fakeCloud();
    const { local } = fakeLocal();
    const created = await ws.workspace.createFile({ name: 'Offline' });
    const doc = await ws.workspace.open(created.id);
    const first = createCloudSync({ api: cloud.api, workspace: ws.workspace, local, userId: 'u1', storage: backing, debounceMs: 60_000 });
    await first.enable(created.id);
    doc.ydoc.transact(() => doc.ydoc.getArray('tokens').push(['unsaved']), YOU);
    first.dispose(); // The app closed before the upload.
    cloud.api.upload.mockClear();
    const second = createCloudSync({ api: cloud.api, workspace: ws.workspace, local, userId: 'u1', storage: backing, debounceMs: 60_000 });
    await second.refresh();
    await vi.waitFor(() => expect(cloud.api.upload).toHaveBeenCalledTimes(1));
    second.dispose();
  });
});
