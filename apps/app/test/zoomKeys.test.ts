import { describe, expect, it } from 'vitest';
import { resolveShortcut } from '../src/commands/keyboard';
import { stepZoom } from '../src/canvas/viewport';

const key = (key: string, code: string, init: Partial<KeyboardEventInit> = {}) => ({ key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init });

describe('zoom shortcuts', () => {
  it('Ctrl + and Ctrl − zoom the canvas on Windows/Linux, ⌘ on macOS', () => {
    expect(resolveShortcut(key('=', 'Equal', { ctrlKey: true }), false)).toBe('zoomIn');
    expect(resolveShortcut(key('+', 'Equal', { ctrlKey: true, shiftKey: true }), false)).toBe('zoomIn');
    expect(resolveShortcut(key('-', 'Minus', { ctrlKey: true }), false)).toBe('zoomOut');
    expect(resolveShortcut(key('+', 'NumpadAdd', { ctrlKey: true }), false)).toBe('zoomIn');
    expect(resolveShortcut(key('-', 'NumpadSubtract', { ctrlKey: true }), false)).toBe('zoomOut');
    expect(resolveShortcut(key('=', 'Equal', { metaKey: true }), true)).toBe('zoomIn');
    expect(resolveShortcut(key('-', 'Minus', { metaKey: true }), true)).toBe('zoomOut');
  });

  it('goes by the typed character, so a layout with + on another key still zooms', () => {
    // German layout: + sits on the key US keyboards call BracketRight.
    expect(resolveShortcut(key('+', 'BracketRight', { ctrlKey: true }), false)).toBe('zoomIn');
  });

  it('steps through the standard zoom levels', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.43, -1)).toBe(0.33);
    expect(stepZoom(0.43, 1)).toBe(0.5);
    expect(stepZoom(256, 1)).toBe(256);
    expect(stepZoom(0.02, -1)).toBe(0.02);
  });
});
