import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { pasteIntoDoc } from '../src/paste';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };
const center = { x: 1000, y: 500 };

function setup() {
  const doc = new MarkupDoc({ name: 'Paste' });
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  return { doc, rootId: page.rootId };
}
const target = (rootId: string, selection: string[] = [], mode?: 'paste' | 'on-top' | 'replace') => ({ selection, rootId, viewportCenter: center, mode });
const allNodes = (doc: MarkupDoc, id: string): ReturnType<MarkupDoc['requireNode']>[] => {
  const n = doc.requireNode(id);
  return [n, ...n.children.flatMap((c) => allNodes(doc, c))];
};
const card = (doc: MarkupDoc, rootId: string) =>
  doc.insertNodes(human, rootId, [{ type: 'frame', name: 'Card', styles: { position: 'absolute', left: 120, top: 80, width: 300, height: 200 } }])[0]!;

afterEach(() => vi.unstubAllGlobals());

describe('paste', () => {
  it('pastes foreign html without scripts', async () => {
    const { doc, rootId } = setup();
    const html =
      '<meta charset="utf-8"><style>p{color:red}</style><!--[if gte mso 9]><xml>x</xml><![endif]-->' +
      '<b id="docs-internal-guid-1234"><div style="padding:8px;mso-line-height-rule:exactly" onclick="alert(1)">' +
      '<script>alert(1)</script><iframe src="https://evil.test"></iframe>' +
      '<p style="mso-style-name:Normal;color:#ff0000">Hello<o:p></o:p></p>' +
      '<a href="javascript:alert(1)">bad</a></div></b>';
    const ids = await pasteIntoDoc(doc, human, { html }, target(rootId));
    expect(ids).toHaveLength(1);
    const dump = JSON.stringify(allNodes(doc, ids[0]!));
    expect(dump).not.toMatch(/script|iframe|onclick|javascript:|mso-|o:p|docs-internal|<meta|<style|\[if/);
    expect(dump).toContain('Hello');
    expect(dump).toContain('#ff0000');
  });

  it('pastes into the selected frame', async () => {
    const { doc, rootId } = setup();
    const frame = card(doc, rootId);
    const ids = await pasteIntoDoc(doc, human, { html: '<p>Hi there</p>' }, target(rootId, [frame]));
    expect(doc.requireNode(frame).children).toEqual(ids);
    expect(doc.requireNode(ids[0]!).type).toBe('text');
    expect(doc.requireNode(rootId).children).toEqual([frame]);
  });

  it('pastes next to a selected non-frame, inside its parent', async () => {
    const { doc, rootId } = setup();
    const frame = card(doc, rootId);
    const [t] = doc.insertNodes(human, frame, [{ type: 'text', text: 'a' }]);
    const ids = await pasteIntoDoc(doc, human, { text: 'b' }, target(rootId, [t!]));
    expect(doc.requireNode(ids[0]!).parentId).toBe(frame);
  });

  it('snapshot payload makes a new artboard', async () => {
    const { doc, rootId } = setup();
    const html =
      '<!--markup:snapshot v1--><div layer-name="Example Domain" data-source="https://example.com" style="position:relative;width:1200px;height:800px"><p style="color:#111111">Example</p></div>' +
      '<div layer-name="Second" style="position:relative;width:400px;height:300px"><p>Two</p></div>';
    const frame = card(doc, rootId);
    const ids = await pasteIntoDoc(doc, human, { html }, target(rootId, [frame]));
    expect(ids).toHaveLength(2);
    const [a, b] = ids.map((id) => doc.requireNode(id));
    expect(a!.parentId).toBe(rootId);
    expect(a!.name).toBe('Example Domain');
    expect(a!.styles).toMatchObject({ position: 'absolute' });
    expect(parseFloat(String(a!.styles.width))).toBe(1200);
    expect(parseFloat(String(a!.styles.height))).toBe(800);
    expect(parseFloat(String(a!.styles.left))).toBe(center.x - (1200 + 80 + 400) / 2);
    expect(parseFloat(String(a!.styles.top))).toBe(center.y - 400);
    expect(b!.name).toBe('Second');
    expect(parseFloat(String(b!.styles.left))).toBe(parseFloat(String(a!.styles.left)) + 1200 + 80);
    expect(doc.requireNode(a!.children[0]!).type).toBe('text');
    expect(doc.requireNode(frame).children).toHaveLength(0);
  });

  const snapshotBody = '<!--markup:snapshot v1--><div layer-name="Wrapped" style="position:relative;width:600px;height:400px"><p>Hi</p></div>';
  it.each([
    ['a meta tag', `<meta charset='utf-8'>${snapshotBody}`],
    ['html/body with fragment comments', `<html><body><!--StartFragment-->${snapshotBody}<!--EndFragment--></body></html>`],
  ])('snapshot payload behind %s still makes an artboard', async (_name, html) => {
    const { doc, rootId } = setup();
    const ids = await pasteIntoDoc(doc, human, { html }, target(rootId));
    expect(ids).toHaveLength(1);
    const n = doc.requireNode(ids[0]!);
    expect(n.name).toBe('Wrapped');
    expect(n.styles).toMatchObject({ position: 'absolute' });
    expect(parseFloat(String(n.styles.width))).toBe(600);
    expect(doc.requireNode(rootId).children).toEqual(ids);
  });

  it('keeps no script-capable styles, urls or images in the stored document', async () => {
    const { doc, rootId } = setup();
    const html =
      '<div style="background:url(javascript:alert(1));width:100px;height:50px">' +
      '<p style="color:#112233;background:url(javascript:alert(2))">kept</p>' +
      '<div style="background-image:url(https://example.com/a.png);width:10px;height:10px">remote</div>' +
      '<div style="width:5px;behavior:url(x.htc);-moz-binding:url(x);height:7px;background:expression(alert(1))">b</div>' +
      '<div style="background:url(data:text/html;base64,PHNjcmlwdD4=)">d</div>' +
      '<img src="data:text/html;base64,PHNjcmlwdD4=" style="width:4px">' +
      '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" style="width:4px">' +
      '<img src="javascript:alert(1)">' +
      '<img src="https://example.com/ok.png" style="width:20px;height:20px">' +
      '<svg width="10" height="10" onload="alert(1)"><rect width="10" height="10" onclick="x()"/><script>alert(1)</script></svg></div>';
    const ids = await pasteIntoDoc(doc, human, { html }, target(rootId));
    const nodes = allNodes(doc, ids[0]!);
    const dump = JSON.stringify(nodes);
    expect(dump).not.toMatch(/javascript:|expression\(|-moz-binding|behavior|data:text\/html|data:image\/svg|onload|onclick|<script|x\.htc/i);
    expect(dump).toContain('https://example.com/a.png');
    expect(dump).toContain('#112233');
    const images = nodes.filter((n) => n.type === 'image');
    expect(images.map((n) => n.src)).toEqual(['https://example.com/ok.png']);
    expect(nodes.find((n) => n.type === 'svg')?.svg).toContain('<rect');
  });

  it('svg text becomes svg node', async () => {
    const { doc, rootId } = setup();
    const ids = await pasteIntoDoc(doc, human, { text: '<svg width="40" height="20" viewBox="0 0 40 20" onload="x()"><script>1</script><rect width="40" height="20"/></svg>' }, target(rootId));
    const svg = allNodes(doc, ids[0]!).find((n) => n.type === 'svg')!;
    expect(svg.svg).toContain('<rect');
    expect(svg.svg).not.toMatch(/script|onload/);
  });

  it('image file becomes image node', async () => {
    const { doc, rootId } = setup();
    vi.stubGlobal('createImageBitmap', async () => ({ width: 3000, height: 1500, close() {} }));
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    const ids = await pasteIntoDoc(doc, human, { files: [file] }, target(rootId));
    const img = allNodes(doc, ids[0]!).find((n) => n.type === 'image')!;
    expect(img.src).toMatch(/^data:image\/png;base64,/);
    expect(parseFloat(String(img.styles.width))).toBe(2000);
    expect(parseFloat(String(img.styles.height))).toBe(1000);
  });

  it('rejects heic when the webview cannot decode it', async () => {
    const { doc, rootId } = setup();
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('nope');
    });
    const file = new File([new Uint8Array([1, 2])], 'p.heic', { type: 'image/heic' });
    await expect(pasteIntoDoc(doc, human, { files: [file] }, target(rootId))).rejects.toThrow('HEIC images are not supported in this browser.');
    expect(doc.requireNode(rootId).children).toHaveLength(0);
  });

  it('plain text becomes text node', async () => {
    const { doc, rootId } = setup();
    const ids = await pasteIntoDoc(doc, human, { text: 'a <b> & c\nline 2' }, target(rootId));
    const t = allNodes(doc, ids[0]!).find((n) => n.type === 'text')!;
    expect(t.text).toContain('a &lt;b&gt; &amp; c');
    expect(t.text).toContain('<br>');
  });

  it('paste is one log entry', async () => {
    const { doc, rootId } = setup();
    const ids = await pasteIntoDoc(doc, human, { html: '<div><p>a</p><p>b</p></div><div><p>c</p></div>' }, target(rootId));
    expect(ids.length).toBeGreaterThan(0);
    const entries = doc.log().filter((e) => e.summary.startsWith('Pasted'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe('Pasted 2 layers');
  });

  it('paste to replace keeps position', async () => {
    const { doc, rootId } = setup();
    const frame = card(doc, rootId);
    const ids = await pasteIntoDoc(doc, human, { html: '<div style="width:50px;height:50px"><p>new</p></div>' }, target(rootId, [frame], 'replace'));
    expect(doc.getNode(frame)).toBeUndefined();
    const n = doc.requireNode(ids[0]!);
    expect(n.parentId).toBe(rootId);
    expect(n.styles).toMatchObject({ left: 120, top: 80, width: 300, height: 200 });
  });

  it('paste on top lands at the selection position, above it', async () => {
    const { doc, rootId } = setup();
    const frame = card(doc, rootId);
    const ids = await pasteIntoDoc(doc, human, { html: '<p>hi</p>' }, target(rootId, [frame], 'on-top'));
    expect(doc.getNode(frame)).toBeDefined();
    const n = doc.requireNode(ids[0]!);
    expect(n.styles).toMatchObject({ position: 'absolute', left: 120, top: 80 });
    const sibs = doc.requireNode(rootId).children;
    expect(sibs.indexOf(ids[0]!)).toBeGreaterThan(sibs.indexOf(frame));
  });

  it('a snapshot root marked data-markup-dialect="any" keeps margin, grid and inline display', async () => {
    const { doc, rootId } = setup();
    const html =
      '<!--markup:snapshot v1--><div data-markup-snapshot="v1" layer-name="Page" data-source="https://a.test/" data-markup-dialect="any" style="position:relative;width:300px;height:100px">' +
      '<div style="position:absolute;left:0px;top:0px;display:grid;grid-template-columns:100px 200px;margin-top:12px">' +
      '<p style="display:inline;margin-left:4px">Hi</p></div></div>';
    const ids = await pasteIntoDoc(doc, human, { html }, target(rootId));
    expect(ids).toHaveLength(1);
    const [root, grid, text] = allNodes(doc, ids[0]!);
    expect(root!.name).toBe('Page');
    expect(grid!.styles).toMatchObject({ display: 'grid', gridTemplateColumns: '100px 200px', marginTop: '12px' });
    expect(text!.type).toBe('text');
    expect(text!.styles).toMatchObject({ display: 'inline', marginLeft: '4px' });
  });

  it('without the dialect attribute a snapshot stays in the strict dialect', async () => {
    const { doc, rootId } = setup();
    const html = '<div data-markup-snapshot="v1" style="position:relative;width:10px;height:10px"><div style="margin-top:12px;display:grid"></div></div>';
    const ids = await pasteIntoDoc(doc, human, { html }, target(rootId));
    const [, child] = allNodes(doc, ids[0]!);
    expect(child!.styles.marginTop).toBeUndefined();
    expect(child!.styles.display).toBeUndefined();
  });
});
