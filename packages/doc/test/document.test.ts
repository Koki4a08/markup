import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MarkupDoc, type Actor } from '../src/index';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

describe('MarkupDoc', () => {
  it('new doc has one page named "Page 1" with a root node', () => {
    const doc = new MarkupDoc();
    const pages = doc.pages();
    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    expect(page.type).toBe('page');
    if (page.type !== 'page') throw new Error('unreachable');
    expect(page.name).toBe('Page 1');
    expect(doc.getNode(page.rootId)?.type).toBe('root');
    expect(doc.nodeCount()).toBe(1);
  });

  it('createPage adds after existing and returns id', () => {
    const doc = new MarkupDoc();
    const id = doc.createPage(human);
    const pages = doc.pages();
    expect(pages).toHaveLength(2);
    expect(pages[1]).toMatchObject({ type: 'page', id, name: 'Page 2', icon: null });
  });

  it('two docs sharing updates converge', () => {
    const a = new MarkupDoc({ name: 'Landing' });
    a.createPage(human, { name: 'Mobile', icon: 'design' });
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(a.ydoc));
    const b = new MarkupDoc({ ydoc });
    expect(b.pages()).toEqual(a.pages());
    expect(b.name).toBe('Landing');
    expect(b.fileId).toBe(a.fileId);
  });

  it('loading an existing ydoc does not add a page', () => {
    const a = new MarkupDoc();
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(a.ydoc));
    const b = new MarkupDoc({ ydoc });
    expect(b.pages()).toHaveLength(1);
  });

  it('requireNode throws NODE_NOT_FOUND', () => {
    const doc = new MarkupDoc();
    expect(() => doc.requireNode('nope')).toThrow(expect.objectContaining({ code: 'NODE_NOT_FOUND' }));
  });

  it('pageOfNode returns the page owning a root', () => {
    const doc = new MarkupDoc();
    const page = doc.pages()[0]!;
    if (page.type !== 'page') throw new Error('unreachable');
    expect(doc.pageOfNode(page.rootId)).toBe(page.id);
  });
});
