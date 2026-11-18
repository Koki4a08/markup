import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MarkupLibrary, type MarkupError } from '../src/index';

let clock = 1000;
beforeEach(() => {
  clock = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10));
});
afterEach(() => vi.restoreAllMocks());

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as MarkupError).code;
  }
  return undefined;
};

describe('MarkupLibrary', () => {
  it('trims names, caps at 500, defaults folder name', () => {
    const lib = new MarkupLibrary();
    expect(lib.addFile({ id: 'f1', name: '  Hello  ' }).name).toBe('Hello');
    expect(lib.addFile({ id: 'f2', name: 'x'.repeat(600) }).name).toHaveLength(500);
    expect(lib.createFolder({}).name).toBe('Untitled project');
    expect(lib.createFolder({ name: '   ' }).name).toBe('Untitled project');
    const f = lib.createFolder({ name: ' Work ' });
    expect(f.name).toBe('Work');
    expect(f.parentId).toBeNull();
    expect(f.archived).toBe(false);
  });

  it('rename keeps old name when empty, trims, caps, bumps updatedAt', () => {
    const lib = new MarkupLibrary();
    const a = lib.addFile({ id: 'a', name: 'Old' });
    expect(lib.rename('a', '   ').name).toBe('Old');
    const r = lib.rename('a', ' New ');
    expect(r.name).toBe('New');
    expect(r.updatedAt).toBeGreaterThan(a.updatedAt);
    expect(lib.rename('a', 'y'.repeat(700)).name).toHaveLength(500);
    expect(codeOf(() => lib.rename('nope', 'x'))).toBe('INVALID_ARGUMENT');
  });

  it('list sorts by updatedAt desc, default limit 50, max 200, truncated only when more', () => {
    const lib = new MarkupLibrary();
    lib.addFile({ id: 'a', name: 'A' });
    lib.addFile({ id: 'b', name: 'B' });
    lib.touch('a');
    const res = lib.list();
    expect(res.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect('truncated' in res).toBe(false);

    const big = new MarkupLibrary();
    for (let i = 0; i < 260; i++) big.addFile({ id: `f${i}`, name: `F${i}` });
    const d = big.list();
    expect(d.items).toHaveLength(50);
    expect(d.truncated).toBe(true);
    expect(big.list({ limit: 1000 }).items).toHaveLength(200);
    expect(big.list({ limit: 1000 }).truncated).toBe(true);
    expect(new MarkupLibrary().list({ limit: 1000 }).truncated).toBeUndefined();
    expect(big.list({ limit: 5 }).items).toHaveLength(5);
  });

  it('list with parentId only lists direct children and hides archived unless included', () => {
    const lib = new MarkupLibrary();
    const folder = lib.createFolder({ name: 'P' });
    const sub = lib.createFolder({ name: 'S', parentId: folder.id });
    lib.addFile({ id: 'a', name: 'A', parentId: folder.id });
    lib.addFile({ id: 'deep', name: 'Deep', parentId: sub.id });
    lib.addFile({ id: 'top', name: 'Top' });
    expect(lib.list({ parentId: folder.id }).items.map((i) => i.id).sort()).toEqual(['a', sub.id].sort());
    lib.archive(['a']);
    expect(lib.list({ parentId: folder.id }).items.map((i) => i.id)).toEqual([sub.id]);
    expect(lib.list({ parentId: folder.id, includeArchived: true }).items).toHaveLength(2);
  });

  it('move moves items, reports alreadyThere, bumps updatedAt', () => {
    const lib = new MarkupLibrary();
    const folder = lib.createFolder({ name: 'P' });
    const a = lib.addFile({ id: 'a', name: 'A' });
    lib.addFile({ id: 'b', name: 'B', parentId: folder.id });
    const r = lib.move(['a', 'b'], folder.id);
    expect(r.moved.map((i) => i.id)).toEqual(['a']);
    expect(r.alreadyThere.map((i) => i.id)).toEqual(['b']);
    expect(lib.get('a')!.parentId).toBe(folder.id);
    expect(lib.get('a')!.updatedAt).toBeGreaterThan(a.updatedAt);
  });

  it('move rejects invalid ids atomically', () => {
    const lib = new MarkupLibrary();
    const folder = lib.createFolder({ name: 'P' });
    lib.addFile({ id: 'a', name: 'A' });
    expect(codeOf(() => lib.move(['a', 'ghost'], folder.id))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => lib.move(['a'], 'ghost'))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => lib.move(['a'], 'a'))).toBe('INVALID_ARGUMENT');
    expect(lib.get('a')!.parentId).toBeNull();
  });

  it('move into itself or a descendant is CYCLE', () => {
    const lib = new MarkupLibrary();
    const p = lib.createFolder({ name: 'P' });
    const c = lib.createFolder({ name: 'C', parentId: p.id });
    expect(codeOf(() => lib.move([p.id], p.id))).toBe('CYCLE');
    expect(codeOf(() => lib.move([p.id], c.id))).toBe('CYCLE');
    expect(lib.get(p.id)!.parentId).toBeNull();
  });

  it('move of a folder and an item inside it is INVALID_ARGUMENT', () => {
    const lib = new MarkupLibrary();
    const p = lib.createFolder({ name: 'P' });
    const dest = lib.createFolder({ name: 'D' });
    lib.addFile({ id: 'in', name: 'In', parentId: p.id });
    expect(codeOf(() => lib.move([p.id, 'in'], dest.id))).toBe('INVALID_ARGUMENT');
    expect(lib.get('in')!.parentId).toBe(p.id);
  });

  it('archive archives a folder subtree; invalid id changes nothing', () => {
    const lib = new MarkupLibrary();
    const p = lib.createFolder({ name: 'P' });
    const c = lib.createFolder({ name: 'C', parentId: p.id });
    lib.addFile({ id: 'a', name: 'A', parentId: c.id });
    lib.addFile({ id: 'other', name: 'O' });
    expect(codeOf(() => lib.archive([p.id, 'ghost']))).toBe('INVALID_ARGUMENT');
    expect(lib.get(p.id)!.archived).toBe(false);
    const out = lib.archive([p.id]);
    expect(out.map((i) => i.id)).toContain(p.id);
    expect(lib.get(c.id)!.archived).toBe(true);
    expect(lib.get('a')!.archived).toBe(true);
    expect(lib.get('other')!.archived).toBe(false);
  });

  it('unarchive restores; item whose folder stays archived goes top level', () => {
    const lib = new MarkupLibrary();
    const p = lib.createFolder({ name: 'P' });
    lib.addFile({ id: 'a', name: 'A', parentId: p.id });
    lib.addFile({ id: 'b', name: 'B', parentId: p.id });
    lib.archive([p.id]);
    const out = lib.unarchive(['a']);
    expect(out[0]!.archived).toBe(false);
    expect(out[0]!.parentId).toBeNull();
    expect(lib.get('a')!.parentId).toBeNull();
    lib.unarchive([p.id]);
    expect(lib.get(p.id)!.archived).toBe(false);
    expect(lib.unarchive(['b'])[0]!.parentId).toBe(p.id);
    expect(codeOf(() => lib.unarchive(['ghost']))).toBe('INVALID_ARGUMENT');
  });

  it('unarchive of a folder restores its subtree, keeping parents', () => {
    const lib = new MarkupLibrary();
    const p = lib.createFolder({ name: 'P' });
    const c = lib.createFolder({ name: 'C', parentId: p.id });
    lib.addFile({ id: 'a', name: 'A', parentId: c.id });
    lib.archive([p.id]);
    lib.unarchive([p.id]);
    for (const id of [p.id, c.id, 'a']) expect(lib.get(id)!.archived).toBe(false);
    expect(lib.get(c.id)!.parentId).toBe(p.id);
    expect(lib.get('a')!.parentId).toBe(c.id);
  });

  it('unarchive reparenting is order independent', () => {
    for (const order of [['a', 'P'], ['P', 'a']]) {
      const lib = new MarkupLibrary();
      const p = lib.createFolder({ name: 'P' });
      lib.addFile({ id: 'a', name: 'A', parentId: p.id });
      lib.archive([p.id]);
      lib.unarchive(order.map((x) => (x === 'P' ? p.id : x)));
      expect(lib.get('a')!.archived).toBe(false);
      expect(lib.get('a')!.parentId).toBe(p.id);
    }
  });

  it('unarchive with an invalid id changes nothing', () => {
    const lib = new MarkupLibrary();
    lib.addFile({ id: 'a', name: 'A' });
    lib.archive(['a']);
    expect(codeOf(() => lib.unarchive(['a', 'ghost']))).toBe('INVALID_ARGUMENT');
    expect(lib.get('a')!.archived).toBe(true);
  });

  it('touch bumps updatedAt and sets thumbnail', () => {
    const lib = new MarkupLibrary();
    const a = lib.addFile({ id: 'a', name: 'A' });
    lib.touch('a', { thumbnail: 'data:x' });
    expect(lib.get('a')!.thumbnail).toBe('data:x');
    expect(lib.get('a')!.updatedAt).toBeGreaterThan(a.updatedAt);
    expect(codeOf(() => lib.touch('ghost'))).toBe('INVALID_ARGUMENT');
  });

  it('persists through a Y update to a second library', () => {
    const one = new MarkupLibrary();
    const p = one.createFolder({ name: 'P' });
    one.addFile({ id: 'a', name: 'A', parentId: p.id });
    const two = new MarkupLibrary();
    Y.applyUpdate(two.ydoc, Y.encodeStateAsUpdate(one.ydoc));
    expect(two.get('a')).toEqual(one.get('a'));
    expect(two.list().items).toHaveLength(2);
  });
});
