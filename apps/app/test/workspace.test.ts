import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkupLibrary, type Actor } from '@markup/doc';
import { importFoundationFile } from '../src/workspace/persistence';
import { fileUrl } from '../src/workspace/Workspace';
import { memoryWorkspace } from './memoryWorkspace';

const you: Actor = { id: 'local-user', kind: 'human', name: 'You' };

afterEach(() => vi.useRealTimers());

describe('workspace', () => {
  it('open twice reuses the doc', async () => {
    const { workspace, addFile, opened } = memoryWorkspace();
    const id = addFile('Landing');
    const [a, b] = await Promise.all([workspace.open(id), workspace.open(id)]);
    const c = await workspace.open(id);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(opened).toEqual([id]);
    expect(workspace.tabs()).toEqual([{ fileId: id, name: 'Landing', active: true }]);
  });

  it('open emits reveal every time, also for the file already in front', async () => {
    const { workspace, addFile } = memoryWorkspace();
    const id = addFile('Front');
    const revealed: string[] = [];
    workspace.on('reveal', (fileId) => revealed.push(fileId));
    await workspace.open(id);
    await workspace.open(id);
    expect(revealed).toEqual([id, id]);
  });

  it('close keeps others', async () => {
    const { workspace, addFile, released } = memoryWorkspace();
    const one = addFile('One');
    const two = addFile('Two');
    const three = addFile('Three');
    for (const id of [one, two, three]) await workspace.open(id);
    workspace.activate(two);
    workspace.close(two);
    expect(workspace.tabs().map((t) => t.fileId)).toEqual([one, three]);
    expect(workspace.doc(two)).toBeUndefined();
    expect(workspace.doc(one)).toBeDefined();
    expect(workspace.activeDoc()?.fileId).toBe(three);
    expect(released).toEqual([two]);
  });

  it('open applies pageId only on the initial open', async () => {
    const { workspace, addFile } = memoryWorkspace();
    const id = addFile('Pages');
    const doc = await workspace.open(id);
    const second = doc.createPage(you, { name: 'Two' });
    const first = doc.pages()[0]!.id;
    workspace.close(id);
    await workspace.open(id, second);
    expect(workspace.activePageId(id)).toBe(second);
    await workspace.open(id, first);
    expect(workspace.activePageId(id)).toBe(second);
  });

  it('createFile with cloneFileId copies pages and nodes', async () => {
    const { workspace, addFile, library } = memoryWorkspace();
    const sourceId = addFile('Source');
    const source = await workspace.open(sourceId);
    source.createPage(you, { name: 'Second' });
    const root = source.rootOf(source.pages()[0]!.id);
    const [artboard] = source.insertNodes(you, root, [{ type: 'frame', name: 'Hero', styles: { width: '100px', height: '50px' }, children: [] }]);
    const folder = library.createFolder({ name: 'Work' });

    const created = await workspace.createFile({ cloneFileId: sourceId, parentId: folder.id });
    expect(created).toMatchObject({ type: 'file', name: 'Source copy', parentId: folder.id, url: fileUrl(created.id) });
    expect(created.id).not.toBe(sourceId);
    expect(workspace.tabs().map((t) => t.fileId)).toEqual([sourceId]);

    const copy = await workspace.open(created.id);
    expect(copy.fileId).toBe(created.id);
    expect(copy.name).toBe('Source copy');
    expect(copy.pages().map((p) => (p.type === 'page' ? p.name : p.type))).toEqual(['Page 1', 'Second']);
    expect(copy.getNode(artboard!)).toMatchObject({ name: 'Hero' });
    expect(copy.log()).toEqual([]);
    // The copy is independent of its source.
    copy.renameNodes(you, [{ nodeId: artboard!, name: 'Changed' }]);
    expect(source.getNode(artboard!)!.name).toBe('Hero');
  });

  it('createFile rejects a parent that is not a folder before creating anything', async () => {
    const { workspace, addFile, library } = memoryWorkspace();
    const file = addFile('A');
    await expect(workspace.createFile({ parentId: file })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(library.list().items).toHaveLength(1);
  });

  it('rename updates the library, the open doc and its tab', async () => {
    const { workspace, addFile } = memoryWorkspace();
    const id = addFile('Old');
    const doc = await workspace.open(id);
    const seen = vi.fn();
    workspace.on('change', seen);
    workspace.rename(id, 'New');
    expect(doc.name).toBe('New');
    expect(workspace.tabs()[0]!.name).toBe('New');
    expect(seen).toHaveBeenCalled();
  });

  it('touches updatedAt debounced after doc edits, and stores a thumbnail on close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1000);
    const { workspace, addFile, library } = memoryWorkspace({ captureThumbnail: async () => 'data:image/png;base64,AAA' });
    const id = addFile('Edited');
    const doc = await workspace.open(id);
    const before = library.get(id)!.updatedAt;
    vi.setSystemTime(5000);
    doc.createPage(you, {});
    doc.createPage(you, {});
    expect(library.get(id)!.updatedAt).toBe(before);
    vi.advanceTimersByTime(2000);
    expect(library.get(id)!.updatedAt).toBe(7000);
    workspace.close(id);
    await vi.waitFor(() => expect(library.get(id)!.thumbnail).toBe('data:image/png;base64,AAA'));
  });

  it('first run imports the foundation file', async () => {
    const library = new MarkupLibrary();
    await importFoundationFile(library, { lastFileId: 'f1', readName: async (id) => (id === 'f1' ? 'My design' : null) });
    expect(library.get('f1')).toMatchObject({ id: 'f1', type: 'file', name: 'My design', parentId: null });
    // Running again does not duplicate or fail.
    await importFoundationFile(library, { lastFileId: 'f1', readName: async () => 'My design' });
    expect(library.list().items).toHaveLength(1);
    // Nothing stored under the id: nothing imported.
    await importFoundationFile(library, { lastFileId: 'gone', readName: async () => null });
    expect(library.get('gone')).toBeUndefined();
  });
});
