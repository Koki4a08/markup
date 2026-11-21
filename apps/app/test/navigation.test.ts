import { afterEach, describe, expect, it } from 'vitest';
import { attachNavigation, wheelDelta, zoomFactor } from '../src/canvas/navigation';
import type { Viewport } from '../src/canvas/viewport';

function setup() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  el.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  let v: Viewport = { x: 0, y: 0, zoom: 1 };
  const detach = attachNavigation(el, { update: (fn) => (v = fn(v)), moving: () => {} });
  return { el, get: () => v, detach };
}

const wheel = (el: Element, init: WheelEventInit) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, ...init });
  el.dispatchEvent(e);
  return e;
};

afterEach(() => (document.body.innerHTML = ''));

describe('canvas navigation', () => {
  it('normalises line and page deltas to pixels', () => {
    expect(wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ x: 0, y: 48 });
    expect(wheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toEqual({ x: 0, y: 600 });
  });

  it('a mouse wheel notch zooms one capped step; a pinch delta zooms smoothly', () => {
    expect(zoomFactor(-120)).toBeCloseTo(1.25);
    expect(zoomFactor(120)).toBeCloseTo(0.8);
    expect(zoomFactor(-2)).toBeCloseTo(Math.exp(0.02));
  });

  it('two-finger trackpad scroll pans both axes and the event is consumed', () => {
    const { el, get } = setup();
    const e = wheel(el, { deltaX: 30, deltaY: 50 });
    expect(get()).toMatchObject({ x: -30, y: -50, zoom: 1 });
    expect(e.defaultPrevented).toBe(true);
  });

  it('a trackpad pinch (ctrl + wheel) zooms at the pointer', () => {
    const { el, get } = setup();
    wheel(el, { deltaY: -10, ctrlKey: true });
    expect(get().zoom).toBeGreaterThan(1);
    // The world point under the pointer stays put.
    const v = get();
    expect((400 - v.x) / v.zoom).toBeCloseTo(400);
  });

  it('Safari gesture events zoom by the scale change', () => {
    const { el, get } = setup();
    const gesture = (type: string, scale: number) => el.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { scale, clientX: 400, clientY: 300 }));
    gesture('gesturestart', 1);
    gesture('gesturechange', 1.5);
    gesture('gesturechange', 2);
    expect(get().zoom).toBeCloseTo(2);
  });
});
