import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorUndo, MarkupDoc, type Actor } from '@markup/doc';
import { runCommand, type CommandContext } from '../src/commands';
import { NODES_MARKER, nodesToHtml } from '../src/clipboard/nodes';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

/** A ClipboardItem stand-in: keeps the blobs it was given and hands them back to clipboard.read(). */
class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
  get types() {
    return Object.keys(this.items);
  }
  async getType(type: string) {
    return this.items[type]!;
  }
}

let board: FakeClipboardItem[] = [];
let texts: string[] = [];
beforeEach(() => {
  board = [];
  texts = [];
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: vi.fn(async (items: FakeClipboardItem[]) => void (board = items)),
      writeText: vi.fn(async (t: string) => {
        texts.push(t);
        board = [new FakeClipboardItem({ 'text/plain': new Blob([t], { type: 'text/plain' }) })];
      }),
      read: vi.fn(async () => board),
    },
  });
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const clipboardText = async (type: string) => board[0]?.items[type]?.text();

function setup() {
  const doc = new MarkupDoc({ name: 'Landing' });
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [
    { type: 'frame', name: 'Artboard', styles: { position: 'absolute', left: 100, top: 50, width: '400px', height: '300px', display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px' } },
  ]);
  const [card, title, icon] = doc.insertNodes(human, artboard!, [
    { type: 'frame', name: 'Card', styles: { width: '120px', height: '40px', backgroundColor: '#ff0000', borderRadius: '6px', flexShrink: '0', marginTop: '4px' } },
    { type: 'text', name: 'Title', text: 'Hello <b>there</b>', styles: { fontSize: '20px', color: '#111111' } },
    { type: 'svg', name: 'Icon', svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', styles: { width: '10px', height: '10px' } },
  ]);
  let selection: string[] = [];
  const notify = vi.fn();
  const ctx: CommandContext = {
    doc,
    actor: human,
    undo: new ActorUndo(doc, human),
    rootId: page.rootId,
    getSelection: () => selection,
    setSelection: (ids) => (selection = ids),
    setTool() {},
    zoomToFit() {},
    zoomTo() {},
    startRename() {},
    collapseLayers() {},
    notify,
    viewportCenter: () => ({ x: 2000, y: 1000 }),
  };
  const select = (...ids: string[]) => (selection = ids);
  return { doc, ctx, notify, select, sel: () => selection, pageId: page.id, rootId: page.rootId, artboard: artboard!, card: card!, title: title!, icon: icon! };
}

/** Renders the given nodes as DOM inside .canvas-world with fixed rects (screen px) and layout widths. */
function renderRects(rects: Record<string, { x: number; y: number; w: number; h: number; offsetWidth?: number }>, parentOf: Record<string, string> = {}) {
  const world = document.createElement('div');
  world.className = 'canvas-world';
  document.body.appendChild(world);
  const els: Record<string, HTMLElement> = {};
  for (const [id, r] of Object.entries(rects)) {
    const el = document.createElement('div');
    el.setAttribute('data-node-id', id);
    el.getBoundingClientRect = () => ({ x: r.x, y: r.y, left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h, toJSON() {} }) as DOMRect;
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: r.offsetWidth ?? r.w });
    els[id] = el;
  }
  for (const [id, el] of Object.entries(els)) (parentOf[id] ? els[parentOf[id]!]! : world).appendChild(el);
}

describe('copy and paste', () => {
  it('copy writes the marked nodes payload as html and the links as text', async () => {
    const { ctx, doc, select, card, title } = setup();
    select(card, title);
    runCommand('copy', ctx);
    await vi.waitFor(() => expect(board).toHaveLength(1));
    const html = (await clipboardText('text/html'))!;
    expect(html.startsWith(`${NODES_MARKER}<div data-markup-nodes="v1" data-markup-dialect="any" data-source-file="${doc.fileId}">`)).toBe(true);
    expect(html).toContain('layer-name="Card"');
    expect(html).toContain('background-color: #ff0000');
    expect(html).toContain('<p layer-name="Title" style="font-size: 20px; color: #111111">Hello <b>there</b></p>');
    expect(await clipboardText('text/plain')).toBe(`markup://file/${doc.fileId}/node/${card}\nmarkup://file/${doc.fileId}/node/${title}`);
  });

  it('serialises frames, text, images and svgs', () => {
    const { doc, card, icon } = setup();
    const [img] = doc.insertNodes(human, card, [{ type: 'image', name: 'Photo', src: 'https://example.com/a.png', styles: { width: 20, height: '20px' } }]);
    const html = nodesToHtml(doc, [card, icon]);
    expect(html).toContain('<img layer-name="Photo" src="https://example.com/a.png" style="width: 20px; height: 20px">');
    expect(html).toMatch(/^<div layer-name="Card" style="[^"]*flex-shrink: 0[^"]*margin-top: 4px">/);
    expect(html).toContain('<svg style="width: 10px; height: 10px" layer-name="Icon" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
    expect(img).toBeDefined();
  });

  it('pastes the payload into the selected frame with the same styles, in one undo step', async () => {
    const { ctx, doc, select, card, title, artboard } = setup();
    select(card, title);
    runCommand('copy', ctx);
    await vi.waitFor(() => expect(board).toHaveLength(1));
    const [target] = doc.insertNodes(human, artboard, [{ type: 'frame', name: 'Target', styles: { display: 'flex' } }]);
    select(target!);
    const before = doc.log().length;
    runCommand('paste', ctx);
    await vi.waitFor(() => expect(doc.requireNode(target!).children).toHaveLength(2));
    expect(doc.log().length).toBe(before + 1);
    const [copyCard, copyTitle] = doc.requireNode(target!).children.map((id) => doc.requireNode(id));
    expect(copyCard).toMatchObject({ type: 'frame', name: 'Card', styles: doc.requireNode(card).styles });
    expect(copyTitle).toMatchObject({ type: 'text', name: 'Title', text: 'Hello <b>there</b>', styles: doc.requireNode(title).styles });
  });

  it('pastes beside a selected non-frame, inside its parent', async () => {
    const { ctx, doc, select, card, title, artboard } = setup();
    select(card);
    runCommand('copy', ctx);
    await vi.waitFor(() => expect(board).toHaveLength(1));
    select(title);
    runCommand('paste', ctx);
    await vi.waitFor(() => expect(doc.requireNode(artboard).children).toHaveLength(4));
  });

  it('with nothing selected, copied artboards keep their position and other nodes get a new artboard', async () => {
    const { ctx, doc, select, artboard, card, rootId } = setup();
    select(artboard);
    runCommand('copy', ctx);
    await vi.waitFor(() => expect(board).toHaveLength(1));
    select();
    runCommand('paste', ctx);
    await vi.waitFor(() => expect(doc.requireNode(rootId).children).toHaveLength(2));
    const pasted = doc.requireNode(doc.requireNode(rootId).children[1]!);
    expect(pasted.styles).toMatchObject({ position: 'absolute', left: '100px', top: '50px', width: '400px' });
    expect(pasted.children).toHaveLength(3);

    select(card);
    runCommand('copy', ctx);
    await vi.waitFor(async () => expect(await clipboardText('text/plain')).toContain(card));
    select();
    runCommand('paste', ctx);
    await vi.waitFor(() => expect(doc.requireNode(rootId).children).toHaveLength(3));
    const wrapper = doc.requireNode(doc.requireNode(rootId).children[2]!);
    expect(wrapper.styles).toMatchObject({ position: 'absolute', left: 2000 - 60 });
    expect(doc.requireNode(wrapper.children[0]!)).toMatchObject({ name: 'Card' });
  });

  it('paste to replace works with the payload', async () => {
    const { ctx, doc, select, card, title, artboard } = setup();
    select(card);
    runCommand('copy', ctx);
    await vi.waitFor(() => expect(board).toHaveLength(1));
    select(title);
    runCommand('pasteToReplace', ctx);
    await vi.waitFor(() => expect(doc.getNode(title)).toBeUndefined());
    expect(doc.requireNode(artboard).children.map((id) => doc.requireNode(id).name)).toEqual(['Card', 'Card', 'Icon']);
  });

  it('copy link writes node links, or the page link without a selection', async () => {
    const { ctx, doc, select, card, notify, pageId } = setup();
    select(card);
    runCommand('copyLink', ctx);
    await vi.waitFor(() => expect(texts).toEqual([`markup://file/${doc.fileId}/node/${card}`]));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Link copied'));
    select();
    runCommand('copyLink', ctx);
    await vi.waitFor(() => expect(texts[1]).toBe(`markup://file/${doc.fileId}/page/${pageId}`));
  });

  it('copy as HTML has no marker, copy as SVG writes the svg markup', async () => {
    const { ctx, select, card, icon } = setup();
    select(card);
    runCommand('copyHtml', ctx);
    await vi.waitFor(() => expect(board).toHaveLength(1));
    const html = (await clipboardText('text/html'))!;
    expect(html).toMatch(/^<div layer-name="Card"/);
    expect(await clipboardText('text/plain')).toBe(html);
    select(icon);
    runCommand('copySvg', ctx);
    await vi.waitFor(() => expect(texts).toEqual(['<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>']));
  });

  it('deselect clears the selection', () => {
    const { ctx, select, card, sel } = setup();
    select(card);
    runCommand('deselect', ctx);
    expect(sel()).toEqual([]);
  });
});

describe('copy and paste styles', () => {
  it('leaves placement and size behind; text-only properties only on text', () => {
    const { ctx, doc, select, card, title, icon, notify } = setup();
    doc.updateStyles(human, [{ nodeIds: [title], styles: { position: 'absolute', left: '3px', fontWeight: 700, opacity: 0.4 } }]);
    select(title);
    runCommand('copyStyles', ctx);
    expect(notify).toHaveBeenCalledWith('Styles copied');
    expect(JSON.parse(localStorage.getItem('markup:styles')!)).toEqual({ fontSize: '20px', color: '#111111', fontWeight: 700, opacity: 0.4 });
    select(card, icon);
    const before = doc.log().length;
    runCommand('pasteStyles', ctx);
    expect(doc.log().length).toBe(before + 1);
    expect(doc.requireNode(card).styles).toMatchObject({ opacity: 0.4, width: '120px', height: '40px', backgroundColor: '#ff0000' });
    expect(doc.requireNode(card).styles.fontSize).toBeUndefined();
    expect(doc.requireNode(card).styles.position).toBeUndefined();
    const [other] = doc.insertNodes(human, doc.requireNode(card).parentId!, [{ type: 'text', text: 'x', styles: { width: '5px' } }]);
    select(other!);
    runCommand('pasteStyles', ctx);
    expect(doc.requireNode(other!).styles).toEqual({ width: '5px', fontSize: '20px', color: '#111111', fontWeight: 700, opacity: 0.4 });
  });
});

describe('remove flex', () => {
  it('pins rendered children absolutely at their measured positions', () => {
    const { ctx, doc, select, artboard, card, title, icon } = setup();
    // Zoom 2: the artboard is 400 px wide in layout and 800 px on screen.
    renderRects(
      {
        [artboard]: { x: 100, y: 100, w: 800, h: 600, offsetWidth: 400 },
        [card]: { x: 120, y: 120, w: 240, h: 80 },
        [title]: { x: 120, y: 216, w: 301, h: 49 },
      },
      { [card]: artboard, [title]: artboard },
    );
    select(artboard);
    const before = doc.log().length;
    runCommand('removeFlex', ctx);
    expect(doc.log().length).toBe(before + 1);
    const a = doc.requireNode(artboard).styles;
    expect(a.display).toBeUndefined();
    expect(a.flexDirection).toBeUndefined();
    expect(a.gap).toBeUndefined();
    expect(a.position).toBe('absolute');
    expect(doc.requireNode(card).styles).toMatchObject({ position: 'absolute', left: '10px', top: '10px', width: '120px', height: '40px' });
    expect(doc.requireNode(title).styles).toMatchObject({ position: 'absolute', left: '10px', top: '58px', width: '151px', height: '25px' });
    // Not rendered: untouched.
    expect(doc.requireNode(icon).styles).toEqual({ width: '10px', height: '10px' });
  });

  it('makes a static frame relative and does nothing for a non-flex frame', () => {
    const { ctx, doc, select, artboard, card } = setup();
    const [inner] = doc.insertNodes(human, card, [{ type: 'frame', name: 'Inner', styles: { width: '4px' } }]);
    doc.updateStyles(human, [{ nodeIds: [card], styles: { display: 'flex' } }]);
    renderRects({ [card]: { x: 0, y: 0, w: 120, h: 40 }, [inner!]: { x: 5, y: 6, w: 4, h: 4 } }, { [inner!]: card });
    select(card);
    runCommand('removeFlex', ctx);
    expect(doc.requireNode(card).styles.position).toBe('relative');
    expect(doc.requireNode(inner!).styles).toMatchObject({ position: 'absolute', left: '5px', top: '6px' });
    const before = doc.log().length;
    select(card);
    runCommand('removeFlex', ctx);
    expect(doc.log().length).toBe(before);
    expect(doc.requireNode(artboard).styles.display).toBe('flex');
  });
});

describe('ungroup', () => {
  it('moves the children into the parent at the frame index and deletes the frame; undo restores it', () => {
    const { ctx, doc, select, sel, artboard, card, title, icon } = setup();
    const [a, b] = doc.insertNodes(human, card, [{ type: 'frame', name: 'a' }, { type: 'frame', name: 'b' }]);
    select(card);
    const before = doc.log().length;
    runCommand('ungroup', ctx);
    expect(doc.log().length).toBe(before + 1);
    expect(doc.getNode(card)).toBeUndefined();
    expect(doc.requireNode(artboard).children).toEqual([a, b, title, icon]);
    expect(sel()).toEqual([a, b]);
    runCommand('undo', ctx);
    expect(doc.requireNode(artboard).children).toEqual([card, title, icon]);
    expect(doc.requireNode(card).children).toEqual([a, b]);
  });

  it('ungrouping an artboard moves its children to the page at their measured positions', () => {
    const { ctx, doc, select, artboard, card, title, icon, rootId } = setup();
    doc.updateStyles(human, [{ nodeIds: [icon], styles: { position: 'absolute', left: '7px', top: '9px' } }]);
    renderRects(
      { [artboard]: { x: 0, y: 0, w: 400, h: 300 }, [card]: { x: 10, y: 10, w: 120, h: 40 }, [title]: { x: 10, y: 58, w: 150, h: 25 } },
      { [card]: artboard, [title]: artboard },
    );
    select(artboard);
    runCommand('ungroup', ctx);
    expect(doc.requireNode(rootId).children).toEqual([card, title, icon]);
    expect(doc.requireNode(card).styles).toMatchObject({ position: 'absolute', left: '110px', top: '60px', width: '120px', height: '40px' });
    expect(doc.requireNode(title).styles).toMatchObject({ position: 'absolute', left: '110px', top: '108px' });
    expect(doc.requireNode(icon).styles).toMatchObject({ position: 'absolute', left: '107px', top: '59px' });
  });
});

describe('arrange', () => {
  function rows() {
    const s = setup();
    const ids = s.doc.insertNodes(human, s.card, ['a', 'b', 'c', 'd'].map((name) => ({ type: 'frame' as const, name })));
    const names = () => s.doc.requireNode(s.card).children.map((id) => s.doc.requireNode(id).name).join('');
    return { ...s, ids, names };
  }

  it('bring to front and send to back', () => {
    const { ctx, select, ids, names } = rows();
    select(ids[0]!, ids[2]!);
    runCommand('bringToFront', ctx);
    expect(names()).toBe('bdac');
    runCommand('sendToBack', ctx);
    expect(names()).toBe('acbd');
  });

  it('move forward and backward one step', () => {
    const { ctx, doc, select, ids, names } = rows();
    select(ids[0]!, ids[1]!);
    const before = doc.log().length;
    runCommand('moveForward', ctx);
    expect(names()).toBe('cabd');
    expect(doc.log().length).toBe(before + 1);
    runCommand('moveForward', ctx);
    expect(names()).toBe('cdab');
    runCommand('moveForward', ctx);
    expect(names()).toBe('cdab');
    select(ids[3]!);
    runCommand('moveBackward', ctx);
    expect(names()).toBe('dcab');
    runCommand('moveBackward', ctx);
    expect(names()).toBe('dcab');
  });
});
