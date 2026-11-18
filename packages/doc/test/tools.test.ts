import { describe, expect, it } from 'vitest';
import { MarkupDoc, runDocTool, type Actor } from '../src/index';

const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };

function setup() {
  const doc = new MarkupDoc({ name: 'Landing' });
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const run = (method: Parameters<typeof runDocTool>[2], params: unknown) => runDocTool(doc, agent, method, params, { activePageId: page.id });
  return { doc, page, run };
}

describe('runDocTool', () => {
  it('create_artboard places 80px right of last', () => {
    const { doc, run } = setup();
    const a = run('create_artboard', { name: 'Desktop', styles: { width: '1440px', height: '900px' } }) as { nodeId: string };
    const b = run('create_artboard', { name: 'Mobile', styles: { width: '390px', height: '844px' } }) as { nodeId: string };
    expect(doc.requireNode(a.nodeId).styles).toMatchObject({ position: 'absolute', left: 0, top: 0, display: 'flex', flexDirection: 'column' });
    expect(doc.requireNode(b.nodeId).styles.left).toBe(1440 + 80);
  });

  it('write_html then get_jsx round trip', () => {
    const { run } = setup();
    const { nodeId } = run('create_artboard', { name: 'A', styles: { width: '400px', height: '300px' } }) as { nodeId: string };
    const w = run('write_html', { targetNodeId: nodeId, mode: 'insert-children', html: '<div layer-name="Hero" style="gap: 8px"><p>Hi</p></div>' }) as { nodeIds: string[] };
    expect(w.nodeIds).toHaveLength(1);
    const jsx = run('get_jsx', { nodeId, includeNodeIds: false }) as string;
    expect(jsx).toContain('<div style={{ gap: "8px" }}>');
    expect(jsx).toContain('<p>Hi</p>');
  });

  it('invalid params returns INVALID_PARAMS', () => {
    const { run } = setup();
    expect(() => run('write_html', { html: '<div/>' })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });

  it('get_basic_info lists artboards and tokens', () => {
    const { run, page } = setup();
    run('create_artboard', { name: 'Desktop', styles: { width: '1440px', height: '900px', fontFamily: 'Inter' } });
    run('create_tokens', { tokens: [{ type: 'color', name: '--bg', value: '#fff' }] });
    const info = run('get_basic_info', {}) as Record<string, unknown>;
    expect(info).toMatchObject({
      fileName: 'Landing',
      page: { id: page.id, name: 'Page 1' },
      pages: [{ type: 'page', id: page.id, name: 'Page 1', icon: null, isActive: true }],
      nodeCount: 2,
      artboards: [{ name: 'Desktop', width: 1440, height: 900, worldX: 0, worldY: 0 }],
      tokens: [{ name: '--bg', type: 'color', value: '#fff' }],
    });
  });

  it('get_node_info returns plain text and children', () => {
    const { run } = setup();
    const { nodeId } = run('create_artboard', { name: 'A', styles: { width: '400px', height: '300px' } }) as { nodeId: string };
    const [textId] = (run('write_html', { targetNodeId: nodeId, mode: 'insert-children', html: '<p>Hi <b>you</b></p>' }) as { nodeIds: string[] }).nodeIds;
    expect(run('get_node_info', { nodeId: textId })).toMatchObject({ id: textId, component: 'Text', textContent: 'Hi you', parentId: nodeId, visible: true, locked: false });
    expect(run('get_children', { nodeId })).toMatchObject([{ id: textId, component: 'Text', childCount: 0 }]);
  });

  it('finish_working_on_nodes releases own indicators', () => {
    const { doc, run } = setup();
    const { nodeId } = run('create_artboard', { name: 'A', styles: { width: '400px', height: '300px' } }) as { nodeId: string };
    doc.setWorking(agent, [nodeId], true);
    run('finish_working_on_nodes', {});
    expect(doc.working()).toEqual({});
  });

  it('create_page returns an id', () => {
    const { doc, run } = setup();
    const { pageId } = run('create_page', { name: 'Mobile', icon: 'design' }) as { pageId: string };
    expect(doc.pages().map((p) => p.id)).toContain(pageId);
  });
});
