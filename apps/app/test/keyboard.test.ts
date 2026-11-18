import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor, ActorUndo } from '@markup/doc';
import { resolveShortcut, shortcutLabel } from '../src/keyboard';
import { runCommand, type CommandContext } from '../src/commands';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };
const key = (k: string, mods: Partial<Record<'meta' | 'shift' | 'alt' | 'ctrl', boolean>> = {}, code?: string) => ({
  key: k,
  code: code ?? `Key${k.toUpperCase()}`,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('keymap', () => {
  it('keymap maps ⇧A to wrap-in-flex', () => {
    expect(resolveShortcut(key('A', { shift: true }), true)).toBe('wrapInFlex');
  });

  it('maps paste on top and paste to replace', () => {
    expect(resolveShortcut(key('v', { meta: true, shift: true }), true)).toBe('pasteOnTop');
    expect(resolveShortcut(key('r', { ctrl: true, shift: true }), false)).toBe('pasteToReplace');
    expect(resolveShortcut(key('v', { meta: true }), true)).toBeNull();
  });

  it('maps the context menu commands', () => {
    expect(resolveShortcut(key('c', { ctrl: true }), false)).toBe('copy');
    expect(resolveShortcut(key('c', { meta: true }), true)).toBe('copy');
    expect(resolveShortcut(key('l', { ctrl: true }), false)).toBe('copyLink');
    expect(resolveShortcut(key('Escape', { shift: true }, 'Escape'), false)).toBe('deselect');
    expect(resolveShortcut(key('Escape', {}, 'Escape'), false)).toBe('selectParent');
    expect(resolveShortcut(key('c', { ctrl: true, alt: true }), false)).toBe('copyStyles');
    expect(resolveShortcut(key('v', { meta: true, alt: true }), true)).toBe('pasteStyles');
    expect(resolveShortcut(key('a', { shift: true, alt: true }), false)).toBe('removeFlex');
    expect(resolveShortcut(key('g', { ctrl: true, shift: true }), false)).toBe('ungroup');
    expect(resolveShortcut(key(']', {}, 'BracketRight'), false)).toBe('bringToFront');
    expect(resolveShortcut(key('[', {}, 'BracketLeft'), false)).toBe('sendToBack');
    expect(resolveShortcut(key(']', { ctrl: true }, 'BracketRight'), false)).toBe('moveForward');
    expect(resolveShortcut(key('[', { meta: true }, 'BracketLeft'), true)).toBe('moveBackward');
    expect(resolveShortcut(key('v', { ctrl: true }), false)).toBeNull();
  });

  it('formats shortcuts per platform', () => {
    expect(shortcutLabel('copyPng', false)).toBe('Ctrl+Shift+C');
    expect(shortcutLabel('copyPng', true)).toBe('⇧⌘C');
    expect(shortcutLabel('copyStyles', false)).toBe('Ctrl+Alt+C');
    expect(shortcutLabel('copyStyles', true)).toBe('⌥⌘C');
    expect(shortcutLabel('removeFlex', false)).toBe('Shift+Alt+A');
    expect(shortcutLabel('copyReact', true)).toBe('⌥R');
    expect(shortcutLabel('deselect', false)).toBe('Shift+Esc');
    expect(shortcutLabel('moveForward', false)).toBe('Ctrl+]');
    expect(shortcutLabel('selectChildren', false)).toBe('Enter');
    expect(shortcutLabel('copyHtml', false)).toBe('');
  });

  it('maps tools and mod shortcuts per platform', () => {
    expect(resolveShortcut(key('v'), true)).toBe('tool:move');
    expect(resolveShortcut(key('t'), true)).toBe('tool:text');
    expect(resolveShortcut(key('z', { meta: true }), true)).toBe('undo');
    expect(resolveShortcut(key('z', { ctrl: true }), false)).toBe('undo');
    expect(resolveShortcut(key('z', { meta: true, shift: true }), true)).toBe('redo');
    expect(resolveShortcut(key('h', { meta: true, shift: true }), true)).toBe('toggleHidden');
    expect(resolveShortcut(key('l', { alt: true }), true)).toBe('collapseLayers');
    expect(resolveShortcut(key('Backspace', {}, 'Backspace'), true)).toBe('delete');
    expect(resolveShortcut(key('!', { shift: true }, 'Digit1'), true)).toBe('zoomToFit');
    expect(resolveShortcut(key('0', { meta: true }, 'Digit0'), true)).toBe('zoomTo100');
    expect(resolveShortcut(key('q'), true)).toBeNull();
  });
});

describe('commands', () => {
  function ctx() {
    const doc = new MarkupDoc();
    const page = doc.pages()[0]!;
    if (page.type !== 'page') throw new Error('unreachable');
    const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'A', styles: { display: 'flex' } }]);
    const [a, b] = doc.insertNodes(human, artboard!, [{ type: 'frame', name: 'a' }, { type: 'frame', name: 'b' }]);
    let selection: string[] = [a!, b!];
    const undo = new ActorUndo(doc, human);
    const c: CommandContext = {
      doc,
      actor: human,
      undo,
      rootId: page.rootId,
      getSelection: () => selection,
      setSelection: (ids) => (selection = ids),
      setTool: () => {},
      zoomToFit: () => {},
      zoomTo: () => {},
      startRename: () => {},
      collapseLayers: () => {},
    };
    return { c, doc, artboard: artboard!, a: a!, b: b!, sel: () => selection };
  }

  it('undo key calls ActorUndo.undo', () => {
    const { c, doc, a } = ctx();
    doc.updateStyles(human, [{ nodeIds: [a], styles: { width: '10px' } }]);
    runCommand('undo', c);
    expect(doc.requireNode(a).styles.width).toBeUndefined();
  });

  it('wrapInFlex wraps the selection in one undo step', () => {
    const { c, doc, artboard, a, b, sel } = ctx();
    runCommand('wrapInFlex', c);
    const [wrapper] = sel();
    expect(doc.requireNode(wrapper!)).toMatchObject({ parentId: artboard, children: [a, b], styles: { display: 'flex' } });
    runCommand('undo', c);
    expect(doc.requireNode(artboard).children).toEqual([a, b]);
  });

  it('delete removes the selection and selects nothing', () => {
    const { c, doc, a, sel } = ctx();
    runCommand('delete', c);
    expect(doc.getNode(a)).toBeUndefined();
    expect(sel()).toEqual([]);
  });

  it('selectParent and selectChildren walk the tree', () => {
    const { c, artboard, a, b, sel } = ctx();
    c.setSelection([a]);
    runCommand('selectParent', c);
    expect(sel()).toEqual([artboard]);
    runCommand('selectChildren', c);
    expect(sel()).toEqual([a, b]);
  });

  it('duplicate selects the copies', () => {
    const { c, doc, artboard, a, sel } = ctx();
    c.setSelection([a]);
    runCommand('duplicate', c);
    expect(sel()).toHaveLength(1);
    expect(sel()[0]).not.toBe(a);
    expect(doc.requireNode(artboard).children).toHaveLength(3);
  });
});
