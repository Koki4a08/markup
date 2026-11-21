import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { HINT } from '../src/picker/overlay';
import { Picker } from '../src/picker/picker';

let a: HTMLElement, b: HTMLElement, c: HTMLElement;
let onCapture: Mock<(t: Element[] | 'page', mode?: 'exact' | 'simplified') => void>;
let picker: Picker;

const key = (k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
};
const hover = (el: Element) => el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));
const click = (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  document.body.innerHTML = '<div id="a"><section id="b"><p id="c">hi</p></section></div>';
  a = document.getElementById('a')!;
  b = document.getElementById('b')!;
  c = document.getElementById('c')!;
  onCapture = vi.fn();
  picker = new Picker(document, onCapture);
});
afterEach(() => picker.stop());

describe('picker', () => {
  it('ArrowUp moves to parent and ArrowDown returns', () => {
    picker.start();
    hover(c);
    expect(picker.target).toBe(c);
    key('ArrowUp');
    expect(picker.target).toBe(b);
    key('ArrowUp');
    expect(picker.target).toBe(a);
    key('ArrowDown');
    expect(picker.target).toBe(b);
    key('ArrowDown');
    expect(picker.target).toBe(c);
    key('ArrowUp');
    key('ArrowUp');
    key('ArrowUp');
    key('ArrowUp');
    expect(picker.target).toBe(document.body);
  });

  it('shift click builds a multi selection', () => {
    picker.start();
    hover(b);
    const e = click(b, { shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    hover(c);
    click(c, { shiftKey: true });
    expect(picker.selected).toEqual([b, c]);
    click(c, { shiftKey: true });
    expect(picker.selected).toEqual([b]);
    hover(a);
    click(a);
    expect(onCapture).toHaveBeenCalledWith([b, a]);
  });

  it('Ctrl+Enter captures the whole page', () => {
    picker.start();
    key('Enter', { ctrlKey: true });
    expect(onCapture).toHaveBeenCalledWith('page');
  });

  it('Enter captures in exact mode; Alt+Enter and Alt+click in simplified mode', () => {
    picker.start();
    hover(c);
    key('Enter');
    expect(onCapture.mock.calls[0]![0]).toEqual([c]);
    expect(onCapture.mock.calls[0]![1] ?? 'exact').toBe('exact');
    key('Enter', { altKey: true });
    expect(onCapture).toHaveBeenLastCalledWith([c], 'simplified');
    click(b, { altKey: true });
    expect(onCapture).toHaveBeenLastCalledWith([b], 'simplified');
    key('Enter', { ctrlKey: true, altKey: true });
    expect(onCapture).toHaveBeenLastCalledWith('page', 'simplified');
  });

  it('hint bar names both modes', () => {
    expect(HINT).toBe('Click ↵ capture · ⇧ add to selection · Alt ↵ simplified · Ctrl ↵ whole page · ↑ ↓ fine-tune · Esc cancel');
  });

  it('Escape stops and removes the overlay', () => {
    const before = document.documentElement.childElementCount;
    picker.start();
    expect(document.documentElement.childElementCount).toBe(before + 1);
    key('Escape');
    expect(document.documentElement.childElementCount).toBe(before);
    expect(picker.target).toBeNull();
  });

  it('keys pass through when inactive', () => {
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    window.addEventListener('click', seen);
    expect(key('ArrowUp').defaultPrevented).toBe(false);
    expect(click(c).defaultPrevented).toBe(false);
    picker.start();
    picker.stop();
    expect(key('Enter').defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalledTimes(3);
    window.removeEventListener('keydown', seen);
    window.removeEventListener('click', seen);
    expect(onCapture).not.toHaveBeenCalled();
  });

  it('manifest declares the command and permissions', () => {
    const m = JSON.parse(readFileSync(resolve(__dirname, '../manifest.json'), 'utf8'));
    expect(m.manifest_version).toBe(3);
    expect(m.name).toBe('Markup Snapshot');
    expect(m.permissions).toEqual(['activeTab', 'scripting', 'clipboardWrite']);
    expect(m.host_permissions).toEqual(['<all_urls>']);
    expect(m.commands['toggle-snapshot'].suggested_key).toEqual({ default: 'Ctrl+Shift+P', mac: 'Command+Shift+P' });
    expect(m.action).toBeDefined();
    expect(m.background.service_worker).toBe('background.js');
  });
});
