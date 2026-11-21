import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorUndo, MarkupDoc, type Actor } from '@markup/doc';

vi.mock('html-to-image', () => ({
  toCanvas: vi.fn(async (_el: HTMLElement, opts: { width: number; height: number; pixelRatio: number }) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(opts.width * opts.pixelRatio);
    canvas.height = Math.round(opts.height * opts.pixelRatio);
    return canvas;
  }),
}));

const saved: { name: string; mimeType: string; size: number }[] = [];
vi.mock('../src/export/clipboard', async (orig) => ({
  ...(await orig<typeof import('../src/export/clipboard')>()),
  saveFile: vi.fn(async (name: string, bytes: Uint8Array, mimeType: string) => {
    saved.push({ name, mimeType, size: bytes.length });
  }),
}));

const { Inspector } = await import('../src/panels/Inspector');
const { SelectionProvider } = await import('../src/canvas/selection');
const { DocProvider } = await import('../src/store/DocProvider');
const { resolveShortcut } = await import('../src/commands/keyboard');
const { runCommand } = await import('../src/commands/commands');

type Ctx = import('../src/commands/commands').CommandContext;
const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };
const restore: (() => void)[] = [];

beforeAll(() => {
  const px = (v: string) => parseFloat(v) || 0;
  const define = (proto: object, key: string, value: PropertyDescriptor) => {
    const before = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { configurable: true, ...value });
    restore.push(() => (before ? Object.defineProperty(proto, key, before) : delete (proto as Record<string, unknown>)[key]));
  };
  define(HTMLElement.prototype, 'offsetWidth', { get(this: HTMLElement) { return px(this.style.width); } });
  define(HTMLElement.prototype, 'offsetHeight', { get(this: HTMLElement) { return px(this.style.height); } });
  define(HTMLCanvasElement.prototype, 'getContext', { value: () => ({}) });
  define(HTMLCanvasElement.prototype, 'toBlob', {
    value(this: HTMLCanvasElement, cb: (b: Blob | null) => void, type = 'image/png') {
      cb(new Blob([`${this.width}x${this.height}`], { type }));
    },
  });
});
afterAll(() => restore.forEach((r) => r()));

const written: string[] = [];
beforeEach(() => {
  saved.length = 0;
  written.length = 0;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (t: string) => void written.push(t)), write: vi.fn(async () => {}) } });
});

function setup() {
  const doc = new MarkupDoc({ name: 'Landing' });
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [a, b] = doc.insertNodes(human, page.rootId, [
    { type: 'frame', name: 'Card', styles: { position: 'absolute', left: 0, top: 0, width: 200, height: 100, backgroundColor: '#ff0000' } },
    { type: 'frame', name: 'Hero', styles: { position: 'absolute', left: 300, top: 0, width: 100, height: 50 } },
  ]);
  let selection: string[] = [];
  const ctx: Ctx = {
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
    notify: vi.fn(),
  };
  return { doc, a: a!, b: b!, ctx };
}

const key = (code: string, mods: Partial<Record<'ctrl' | 'shift' | 'alt', boolean>>) => ({ key: code.replace('Key', ''), code, metaKey: false, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt });

describe('export ui', () => {
  it('adding a setting writes it to the node', () => {
    const { doc, a } = setup();
    render(
      <DocProvider doc={doc} actor={human}>
        <SelectionProvider initial={[a]}>
          <Inspector />
        </SelectionProvider>
      </DocProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add export setting' }));
    expect(doc.exportsOf(a)).toEqual([{ format: 'png', scale: '2x' }]);
    const format = screen.getByLabelText('Export format 1') as HTMLSelectElement;
    expect([...format.options].map((o) => o.value)).not.toContain('mp4');
    fireEvent.change(format, { target: { value: 'webp' } });
    fireEvent.change(screen.getByLabelText('Export scale 1'), { target: { value: '512w' } });
    fireEvent.blur(screen.getByLabelText('Export scale 1'));
    expect(doc.exportsOf(a)).toEqual([{ format: 'webp', scale: '512w' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove export setting 1' }));
    expect(doc.exportsOf(a)).toEqual([]);
  });

  it('⌥R copies jsx without ids', async () => {
    const { ctx, a } = setup();
    ctx.setSelection([a]);
    const command = resolveShortcut(key('KeyR', { alt: true }), false);
    expect(command).toBe('copyReact');
    await act(async () => runCommand(command!, ctx));
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain('<div');
    expect(written[0]).toContain('style={{');
    expect(written[0]).not.toContain('data-node-id');
    expect(written[0]).not.toContain(a);
  });

  it('⌥T copies tailwind', async () => {
    const { ctx, a, b } = setup();
    ctx.setSelection([a, b]);
    const command = resolveShortcut(key('KeyT', { alt: true }), false);
    expect(command).toBe('copyTailwind');
    await act(async () => runCommand(command!, ctx));
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain('className=');
    expect(written[0]).not.toContain('style={{');
    expect(written[0]).toContain('\n\n');
  });

  it('⌘⇧E exports each selected node', async () => {
    const { ctx, doc, a, b } = setup();
    doc.setExports(human, a, [{ format: 'png', scale: '1x' }, { format: 'webp', scale: '2x' }]);
    ctx.setSelection([a, b]);
    const command = resolveShortcut(key('KeyE', { ctrl: true, shift: true }), false);
    expect(command).toBe('exportSelection');
    await act(async () => runCommand(command!, ctx));
    await vi.waitFor(() => expect(saved).toHaveLength(3));
    expect(saved.map((s) => s.name).sort()).toEqual(['Card@1x.png', 'Card@2x.webp', 'Hero@2x.png']);
    expect(saved.find((s) => s.name === 'Hero@2x.png')).toMatchObject({ mimeType: 'image/png', size: '200x100'.length });
  });

  it('⌘⇧C copies the selection as a png image', async () => {
    const { ctx, a } = setup();
    ctx.setSelection([a]);
    class Item {
      constructor(public data: Record<string, Blob>) {}
    }
    vi.stubGlobal('ClipboardItem', Item);
    expect(resolveShortcut(key('KeyC', { ctrl: true, shift: true }), false)).toBe('copyPng');
    await act(async () => runCommand('copyPng', ctx));
    await vi.waitFor(() => expect(navigator.clipboard.write).toHaveBeenCalledTimes(1));
    vi.unstubAllGlobals();
  });

  it('reports a clipboard failure instead of throwing', async () => {
    const { ctx, a } = setup();
    ctx.setSelection([a]);
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('denied'));
    await act(async () => runCommand('copyReact', ctx));
    await vi.waitFor(() => expect(ctx.notify).toHaveBeenCalledWith(expect.stringMatching(/could not copy/i)));
  });
});
