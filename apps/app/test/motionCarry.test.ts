import { describe, expect, it } from 'vitest';
import { addFontFaces, addKeyframes, fontFaces, keyframeRules, MarkupDoc, type Actor } from '@markup/doc';
import { sanitizeSvg } from '../src/canvas/NodeView';
import { nodesPayload } from '../src/clipboard/nodes';
import { pasteIntoDoc } from '../src/clipboard/paste';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };
const center = { x: 1000, y: 500 };

function setup(name = 'File') {
  const doc = new MarkupDoc({ name });
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  return { doc, rootId: page.rootId };
}
const allNodes = (doc: MarkupDoc, id: string): ReturnType<MarkupDoc['requireNode']>[] => {
  const n = doc.requireNode(id);
  return [n, ...n.children.flatMap((c) => allNodes(doc, c))];
};

const FADE = '@keyframes mk-fadeIn-a1{0%{opacity:0}100%{opacity:1}}';
const SPIN = '@keyframes mk-spin-b2{0%{--angle:0deg}100%{--angle:360deg}}';
const ANGLE = '@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }';
const UNUSED = '@keyframes mk-other-c3{0%{opacity:1}100%{opacity:0}}';
const FACE = (family: string) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,AAAA);font-weight:400}`;

describe('copying layers between files', () => {
  function source() {
    const { doc, rootId } = setup('Source');
    addKeyframes(doc, [FADE, SPIN, ANGLE, UNUSED].join('\n'));
    addFontFaces(doc, FACE('Matter') + FACE('Unused Sans'));
    const [effects, card] = doc.insertNodes(human, rootId, [
      { type: 'svg', name: 'SVG effects', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"><defs><filter id="mk-filter-x1"><feGaussianBlur stdDeviation="4"></feGaussianBlur></filter></defs></svg>', styles: { position: 'absolute', left: 0, top: 0, width: '0px', height: '0px' } },
      {
        type: 'frame',
        name: 'Card',
        styles: { position: 'absolute', left: 100, top: 100, width: '200px', height: '100px', animationName: 'mk-fadeIn-a1, mk-spin-b2', animationDuration: '600ms, 3s', filter: 'url(#mk-filter-x1)', '--angle': '0deg', background: 'conic-gradient(from var(--angle), red, blue)' },
        children: [{ type: 'text', text: 'Hi', styles: { fontFamily: 'Matter, sans-serif' } }],
      },
    ]);
    return { doc, effects: effects!, card: card! };
  }

  it('brings the fonts, keyframes, @property rules and SVG definitions the layers use, and nothing else', async () => {
    const { doc, card } = source();
    const html = nodesPayload(doc, [card]);
    const { doc: other, rootId } = setup('Other');
    const ids = await pasteIntoDoc(other, human, { html }, { selection: [], rootId, viewportCenter: center });
    expect(keyframeRules(other).sort()).toEqual([ANGLE, FADE, SPIN].sort());
    expect(fontFaces(other)).toHaveLength(1);
    expect(fontFaces(other)[0]).toContain('Matter');
    const dump = JSON.stringify(ids.flatMap((id) => allNodes(other, id)));
    expect(dump).toContain('"name":"SVG effects"');
    expect(dump).toContain('id=\\"mk-filter-x1\\"');
    expect(dump).toContain('"filter":"url(#mk-filter-x1)"');
  });

  it('pasting in the same file does not add another SVG effects layer', async () => {
    const { doc, card } = source();
    const html = nodesPayload(doc, [card]);
    const page = doc.pages()[0]!;
    if (page.type !== 'page') throw new Error('unreachable');
    const ids = await pasteIntoDoc(doc, human, { html }, { selection: [], rootId: page.rootId, viewportCenter: center });
    expect(JSON.stringify(ids.flatMap((id) => allNodes(doc, id)))).not.toContain('SVG effects');
  });
});

describe('SVG animation (SMIL)', () => {
  it('keeps animations of presentation and geometry', () => {
    const svg = sanitizeSvg(
      '<svg viewBox="0 0 10 10"><circle r="4" cx="5" cy="5"><animate attributeName="opacity" values="1;0.2;1" dur="1.2s" repeatCount="indefinite"></animate><animateTransform attributeName="transform" type="rotate" from="0 5 5" to="360 5 5" dur="2s" repeatCount="indefinite"></animateTransform><set attributeName="fill" to="red" begin="1s"></set></circle></svg>',
    );
    expect(svg).toContain('<animate attributeName="opacity" values="1;0.2;1"');
    expect(svg).toContain('from="0 5 5" to="360 5 5"');
    expect(svg).toContain('<set attributeName="fill" to="red"');
  });

  it('drops animations that would rewrite links or load something', () => {
    const svg = sanitizeSvg(
      '<svg><a href="#x"><text>t</text><animate attributeName="href" to="javascript:alert(1)"></animate><set attributeName="onclick" to="alert(1)"></set><animate attributeName="fill" to="url(https://evil.test/p.svg#p)"></animate></a></svg>',
    );
    expect(svg).not.toContain('animate');
    expect(svg).not.toContain('<set');
    expect(svg).not.toContain('javascript');
    expect(svg).not.toContain('evil.test');
  });
});
