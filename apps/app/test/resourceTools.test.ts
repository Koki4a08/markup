import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@markup/doc';
import { runResourceTool } from '../src/bridge/resourceTools';
import { memoryWorkspace } from './memoryWorkspace';

const agent: Actor = { id: 'agent:c1', kind: 'agent', name: 'Claude Code' };

function setup() {
  const ws = memoryWorkspace();
  const run = (method: Parameters<typeof runResourceTool>[1], params: unknown = {}) => runResourceTool(ws.workspace, method, params, { actor: agent });
  return { ...ws, run };
}

describe('resource tools', () => {
  it('list_resources lists open tabs first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { workspace, addFile, library, run } = setup();
      vi.setSystemTime(1000);
      const old = addFile('Old');
      vi.setSystemTime(2000);
      const folder = library.createFolder({ name: 'Projects' });
      vi.setSystemTime(3000);
      const recent = addFile('Recent', folder.id);
      vi.setSystemTime(4000);
      const other = addFile('Other');
      await workspace.open(old);
      await workspace.open(recent);
      workspace.activate(old);

      const res = (await run('list_resources')) as { items: Record<string, unknown>[]; truncated?: true };
      expect(res.items.map((i) => i.id)).toEqual([old, recent, other, folder.id]);
      expect(res.items[0]).toMatchObject({ type: 'file', name: 'Old', open: true, active: true, draft: true, url: `markup://file/${old}` });
      expect(res.items[0]).not.toHaveProperty('parentId');
      expect(res.items[1]).toMatchObject({ open: true, active: false, parentId: folder.id });
      expect(res.items[2]).not.toHaveProperty('open');
      expect(res.items[3]).toMatchObject({ type: 'folder', name: 'Projects', draft: true });
      expect(res.items[3]).not.toHaveProperty('open');
      expect(res.truncated).toBeUndefined();

      const page = (await run('list_resources', { limit: 2 })) as { items: { id: string }[]; truncated?: true };
      expect(page.items.map((i) => i.id)).toEqual([old, recent]);
      expect(page.truncated).toBe(true);

      const inside = (await run('list_resources', { parentId: folder.id })) as { items: { id: string }[] };
      expect(inside.items.map((i) => i.id)).toEqual([recent]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('list_resources hides archived items unless asked', async () => {
    const { addFile, library, run } = setup();
    const a = addFile('A');
    library.archive([a]);
    expect(((await run('list_resources')) as { items: unknown[] }).items).toEqual([]);
    const all = (await run('list_resources', { includeArchived: true })) as { items: Record<string, unknown>[] };
    expect(all.items[0]).toMatchObject({ id: a, archived: true });
  });

  it('open_file opens a tab in the foreground and returns basic info', async () => {
    const { workspace, addFile, run } = setup();
    const a = addFile('A');
    const b = addFile('B');
    await workspace.open(a);
    const info = (await run('open_file', { fileId: b })) as { fileId: string; fileName: string; pages: unknown[] };
    expect(info).toMatchObject({ fileId: b, fileName: 'B' });
    expect(workspace.tabs()).toEqual([
      { fileId: a, name: 'A', active: false },
      { fileId: b, name: 'B', active: true },
    ]);
  });

  it('open_file accepts markup:// url', async () => {
    const { workspace, addFile, run } = setup();
    const a = addFile('A');
    await expect(run('open_file', { fileId: `markup://file/${a}` })).resolves.toMatchObject({ fileId: a });
    workspace.close(a);
    await expect(run('open_file', { fileId: `/file/${a}` })).resolves.toMatchObject({ fileId: a });
  });

  it('open_file applies pageId only on the initial open, including one in the URL', async () => {
    const { workspace, addFile, run } = setup();
    const a = addFile('A');
    const doc = await workspace.open(a);
    const two = doc.createPage(agent, { name: 'Two' });
    const one = doc.pages()[0]!.id;
    workspace.close(a);
    const info = (await run('open_file', { fileId: `markup://file/${a}/${two}` })) as { page: { id: string } };
    expect(info.page.id).toBe(two);
    const again = (await run('open_file', { fileId: a, pageId: one })) as { page: { id: string } };
    expect(again.page.id).toBe(two);
  });

  it('open_file rejects unknown files and folders', async () => {
    const { library, run } = setup();
    await expect(run('open_file', { fileId: 'nope' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('list_resources') });
    const folder = library.createFolder({});
    await expect(run('open_file', { fileId: folder.id })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('create_file returns id, name, parentId and url without opening it', async () => {
    const { workspace, library, run } = setup();
    const folder = library.createFolder({ name: 'F' });
    const res = (await run('create_file', { name: 'Fresh', parentId: folder.id })) as Record<string, unknown>;
    expect(res).toEqual({ id: expect.any(String), type: 'file', name: 'Fresh', parentId: folder.id, url: `markup://file/${res.id}` });
    expect(workspace.tabs()).toEqual([]);
    expect(library.get(res.id as string)).toMatchObject({ name: 'Fresh' });
  });

  it('create_folder creates a folder', async () => {
    const { library, run } = setup();
    const res = (await run('create_folder', {})) as { id: string; name: string; type: string };
    expect(res).toMatchObject({ type: 'folder', name: 'Untitled project' });
    expect(library.get(res.id)?.type).toBe('folder');
  });

  it('rename_resource returns the stored name and type', async () => {
    const { workspace, addFile, run } = setup();
    const a = addFile('A');
    await workspace.open(a);
    expect(await run('rename_resource', { resourceId: a, name: '  Renamed  ' })).toEqual({ id: a, type: 'file', name: 'Renamed' });
    expect(workspace.doc(a)!.name).toBe('Renamed');
    expect(await run('rename_resource', { resourceId: a, name: '' })).toEqual({ id: a, type: 'file', name: 'Renamed' });
  });

  it('move_resources lists items already in the folder separately', async () => {
    const { addFile, library, run } = setup();
    const folder = library.createFolder({ name: 'F' });
    const a = addFile('A');
    const b = addFile('B', folder.id);
    const res = (await run('move_resources', { resourceIds: [a, b], parentId: folder.id })) as { moved: { id: string; parentId: string }[]; alreadyThere: { id: string }[] };
    expect(res.moved.map((i) => [i.id, i.parentId])).toEqual([[a, folder.id]]);
    expect(res.alreadyThere.map((i) => i.id)).toEqual([b]);
    await expect(run('move_resources', { resourceIds: [folder.id], parentId: folder.id })).rejects.toMatchObject({ code: 'CYCLE' });
  });

  it('archive_resources archives folders with their contents', async () => {
    const { addFile, library, run } = setup();
    const folder = library.createFolder({ name: 'F' });
    const a = addFile('A', folder.id);
    const res = (await run('archive_resources', { resourceIds: [folder.id] })) as { items: { id: string; archived: boolean }[] };
    expect(res.items).toEqual([expect.objectContaining({ id: folder.id, archived: true })]);
    expect(library.get(a)!.archived).toBe(true);
    await expect(run('archive_resources', { resourceIds: [] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('unarchive_resources returns where each item ended up', async () => {
    const { addFile, library, run } = setup();
    const folder = library.createFolder({ name: 'F' });
    const a = addFile('A', folder.id);
    library.archive([folder.id]);
    const res = (await run('unarchive_resources', { resourceIds: [a] })) as { items: Record<string, unknown>[] };
    expect(res.items).toEqual([expect.objectContaining({ id: a })]);
    expect(res.items[0]).not.toHaveProperty('archived');
    expect(res.items[0]).not.toHaveProperty('parentId');
    expect(library.get(a)!.parentId).toBeNull();
  });
});
