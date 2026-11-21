import { afterEach, describe, expect, it } from 'vitest';
import { installNativeBehaviour, isBrowserShortcut, type ShortcutLike } from '../src/desktop/native';
import { tabShortcut, tabTarget } from '../src/desktop/tabShortcuts';

const key = (code: string, mods: Partial<ShortcutLike> = {}): ShortcutLike => ({ key: '', code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe('isBrowserShortcut', () => {
  it('catches reload, print, find and history keys', () => {
    expect(isBrowserShortcut(key('F5'), false)).toBe(true);
    expect(isBrowserShortcut(key('KeyR', { ctrlKey: true }), false)).toBe(true);
    expect(isBrowserShortcut(key('KeyP', { ctrlKey: true }), false)).toBe(true);
    expect(isBrowserShortcut(key('KeyF', { ctrlKey: true }), false)).toBe(true);
    expect(isBrowserShortcut(key('F7'), false)).toBe(true);
    expect(isBrowserShortcut(key('ArrowLeft', { altKey: true }), false)).toBe(true);
  });

  it('leaves editing and app keys alone', () => {
    expect(isBrowserShortcut(key('KeyC', { ctrlKey: true }), false)).toBe(false);
    expect(isBrowserShortcut(key('KeyZ', { ctrlKey: true }), false)).toBe(false);
    expect(isBrowserShortcut(key('KeyR'), false)).toBe(false);
    // macOS: ⌘H hides the app and ⌘R/⌘P have no browser meaning in WKWebView; the menu bar keeps them.
    expect(isBrowserShortcut(key('KeyH', { metaKey: true }), true)).toBe(false);
    expect(isBrowserShortcut(key('KeyR', { ctrlKey: true }), true)).toBe(false);
    expect(isBrowserShortcut(key('ArrowLeft'), false)).toBe(false);
  });
});

describe('installNativeBehaviour', () => {
  let remove: (() => void) | undefined;
  afterEach(() => {
    remove?.();
    remove = undefined;
    document.body.innerHTML = '';
  });

  const fire = (target: EventTarget, event: Event) => {
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('suppresses the browser context menu on the desktop, except in text fields', () => {
    remove = installNativeBehaviour({ desktop: true, mac: false });
    document.body.innerHTML = '<div id="panel">Layers</div><input id="field" />';
    expect(fire(document.getElementById('panel')!, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(true);
    expect(fire(document.getElementById('field')!, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false);
  });

  it('keeps the browser context menu and reload in a browser tab', () => {
    remove = installNativeBehaviour({ desktop: false, mac: false });
    document.body.innerHTML = '<div id="panel">Layers</div>';
    expect(fire(document.getElementById('panel')!, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false);
    expect(fire(window, new KeyboardEvent('keydown', { code: 'F5', cancelable: true }))).toBe(false);
  });

  it('blocks reload keys on the desktop', () => {
    remove = installNativeBehaviour({ desktop: true, mac: false });
    expect(fire(window, new KeyboardEvent('keydown', { code: 'KeyR', ctrlKey: true, cancelable: true }))).toBe(true);
  });

  it('never follows links in designs', () => {
    remove = installNativeBehaviour({ desktop: false });
    document.body.innerHTML = '<a id="link" href="https://example.com"><span id="inner">x</span></a><a id="dl" href="blob:x" download="a.png">a</a>';
    expect(fire(document.getElementById('inner')!, new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true);
    // Browser-mode export clicks its own download anchor.
    expect(fire(document.getElementById('dl')!, new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
  });

  it('refuses file drops nothing accepted, but lets an accepting handler through', () => {
    remove = installNativeBehaviour({ desktop: false });
    const files = () => {
      const e = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], dropEffect: 'copy' } });
      return e;
    };
    const refused = files();
    window.dispatchEvent(refused);
    expect(refused.defaultPrevented).toBe(true);
    expect(refused.dataTransfer!.dropEffect).toBe('none');

    const accepted = files();
    accepted.preventDefault();
    window.dispatchEvent(accepted);
    expect(accepted.dataTransfer!.dropEffect).toBe('copy');
  });

  it('gives focus back after a mouse click on a toolbar button, but not inside a menu', () => {
    remove = installNativeBehaviour({ desktop: false });
    document.body.innerHTML = '<button id="tool">Move</button><div role="menu"><button id="item">Copy</button></div>';
    for (const [id, keeps] of [['tool', false], ['item', true]] as const) {
      const button = document.getElementById(id)!;
      button.focus();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      expect(document.activeElement === button).toBe(keeps);
    }
  });
});

describe('tab shortcuts', () => {
  it('maps Windows chords', () => {
    expect(tabShortcut(key('KeyW', { ctrlKey: true }), false)).toEqual({ kind: 'close' });
    expect(tabShortcut(key('Tab', { ctrlKey: true }), false)).toEqual({ kind: 'cycle', step: 1 });
    expect(tabShortcut(key('Tab', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'cycle', step: -1 });
    expect(tabShortcut(key('PageUp', { ctrlKey: true }), false)).toEqual({ kind: 'cycle', step: -1 });
    expect(tabShortcut(key('Digit3', { ctrlKey: true }), false)).toEqual({ kind: 'goto', index: 2 });
    expect(tabShortcut(key('Digit9', { ctrlKey: true }), false)).toEqual({ kind: 'goto', index: -1 });
    expect(tabShortcut(key('KeyN', { ctrlKey: true }), false)).toEqual({ kind: 'new' });
    expect(tabShortcut(key('Digit0', { ctrlKey: true }), false)).toBeNull();
  });

  it('leaves ⌘W and ⌘N to the macOS File menu', () => {
    expect(tabShortcut(key('KeyW', { metaKey: true }), true)).toBeNull();
    expect(tabShortcut(key('KeyN', { metaKey: true }), true)).toBeNull();
    expect(tabShortcut(key('Digit1', { metaKey: true }), true)).toEqual({ kind: 'goto', index: 0 });
    expect(tabShortcut(key('Tab', { ctrlKey: true }), true)).toEqual({ kind: 'cycle', step: 1 });
  });

  it('finds the target tab, wrapping at the ends', () => {
    const ids = ['a', 'b', 'c'];
    expect(tabTarget(ids, 'c', { kind: 'cycle', step: 1 })).toBe('a');
    expect(tabTarget(ids, 'a', { kind: 'cycle', step: -1 })).toBe('c');
    expect(tabTarget(ids, null, { kind: 'cycle', step: 1 })).toBe('a');
    expect(tabTarget(ids, 'a', { kind: 'goto', index: -1 })).toBe('c');
    expect(tabTarget(ids, 'a', { kind: 'goto', index: 5 })).toBeNull();
    expect(tabTarget([], null, { kind: 'cycle', step: 1 })).toBeNull();
  });
});
