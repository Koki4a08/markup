import type { CaptureEnv, Pseudo } from './env';

/**
 * Computed style read once per element, pseudo-element and property for one serialization pass. Both serializers
 * read the same values many times (display and visibility per walk step, a parent's inherited properties for each
 * of its children), and each live read re-serializes the value. Capture does not change the page while it walks
 * it, so within one pass the first read of a value is the value; a new pass (a new capture) starts empty.
 *
 * Only getPropertyValue is answered: that is the one member the serializers read (styles.ts `get`).
 */
export function memoStyles(env: CaptureEnv): CaptureEnv {
  const byElement = new WeakMap<Element, Map<string, CSSStyleDeclaration>>();
  return {
    ...env,
    style(el: Element, pseudo?: Pseudo) {
      let forEl = byElement.get(el);
      if (!forEl) byElement.set(el, (forEl = new Map()));
      const key = pseudo ?? '';
      let cs = forEl.get(key);
      if (!cs) forEl.set(key, (cs = memoDecl(env.style(el, pseudo))));
      return cs;
    },
  };
}

function memoDecl(live: CSSStyleDeclaration): CSSStyleDeclaration {
  const values = new Map<string, string>();
  return {
    getPropertyValue(prop: string): string {
      let v = values.get(prop);
      if (v === undefined) values.set(prop, (v = live.getPropertyValue(prop)));
      return v;
    },
  } as CSSStyleDeclaration;
}
