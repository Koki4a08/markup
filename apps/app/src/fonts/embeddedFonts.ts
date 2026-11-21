import { fontFaces, fontsMap, keyframeRules, keyframesMap, type MarkupDoc } from '@markup/doc';

/**
 * Web fonts and @keyframes embedded in a file (from page snapshots) become a <style> of @font-face and
 * @keyframes rules while the file is shown or exported. A stylesheet rather than FontFace objects, so exports
 * that inline fonts from the document's sheets (html-to-image) carry them too. Reference-counted: the editor
 * and an export host can hold the same file at once.
 */

interface Entry {
  count: number;
  style: HTMLStyleElement;
  stop: () => void;
}

const live = new WeakMap<MarkupDoc, Entry>();

export function retainEmbeddedFonts(doc: MarkupDoc): () => void {
  let entry = live.get(doc);
  if (!entry) {
    const style = document.createElement('style');
    style.setAttribute('data-markup-embedded-fonts', '');
    const write = () => {
      const css = [...fontFaces(doc), ...keyframeRules(doc)].join('\n');
      if (style.textContent !== css) style.textContent = css;
    };
    write();
    document.head.appendChild(style);
    const maps = [fontsMap(doc), keyframesMap(doc)];
    maps.forEach((m) => m.observe(write));
    entry = { count: 0, style, stop: () => maps.forEach((m) => m.unobserve(write)) };
    live.set(doc, entry);
  }
  entry.count++;
  const held = entry;
  return () => {
    if (--held.count > 0) return;
    held.stop();
    held.style.remove();
    live.delete(doc);
  };
}
