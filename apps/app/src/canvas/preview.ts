import { useSyncExternalStore } from 'react';
import type { Styles, StyleValue } from '@markup/doc';
import { toCss } from './NodeView';
import { canvasNodeElement } from './registry';

/**
 * Live style previews: while a value is being typed, scrubbed, picked or dragged, the canvas shows it at
 * once without touching the document. One edit then commits once (one history entry, one agent-visible
 * change), and a cancelled edit puts the rendered node back exactly as it was.
 */

type Live = Record<string, Record<string, StyleValue | null>>;

let live: Live = {};
let previewing = 0;
const originals = new Map<HTMLElement, Map<string, string>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const canvasEl = canvasNodeElement;

/** Runs fn with document writes turned into previews (see isPreviewing). */
export function runPreview(fn: () => void): void {
  previewing++;
  try {
    fn();
  } finally {
    previewing--;
  }
}

/** True inside runPreview: style setters should call previewStyles instead of writing the document. */
export const isPreviewing = () => previewing > 0;

/** Shows styles on the rendered nodes now, remembering what each touched property was. */
export function previewStyles(ids: string[], styles: Record<string, StyleValue | null>): void {
  const css = toCss(Object.fromEntries(Object.entries(styles).filter(([, v]) => v !== null)) as Styles) as Record<string, string>;
  for (const id of ids) {
    const el = canvasEl(id);
    if (el) {
      let saved = originals.get(el);
      if (!saved) originals.set(el, (saved = new Map()));
      const style = el.style as unknown as Record<string, string>;
      // Cleared keys go first: clearing a longhand (rowGap) after setting its shorthand (gap) would undo part of it.
      const keys = Object.keys(styles).sort((x, y) => Number(styles[y] === null) - Number(styles[x] === null));
      // Every original is read before any write: a write can change how a related property reads back.
      for (const key of keys) if (!saved.has(key)) saved.set(key, style[key] ?? '');
      for (const key of keys) style[key] = css[key] ?? '';
    }
  }
  emit();
}

/** Publishes values a gesture is already drawing itself (a resize), so panels can show them live. */
export function announceLive(ids: string[], styles: Record<string, StyleValue | null>): void {
  for (const id of ids) live = { ...live, [id]: { ...live[id], ...styles } };
  emit();
}

/** Ends every preview: rendered nodes get their previous inline values back, panels their stored ones. */
export function endPreview(): void {
  if (!originals.size && !Object.keys(live).length) return;
  for (const [el, saved] of originals) {
    const style = el.style as unknown as Record<string, string>;
    // Cleared originals first, so restoring an empty longhand cannot blank a restored shorthand.
    for (const [key, value] of [...saved].sort(([, x], [, y]) => Number(y === '') - Number(x === ''))) style[key] = value;
  }
  originals.clear();
  live = {};
  emit();
}

export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Values a canvas gesture is drawing right now (a resize), per node id, for panels to mirror. Field
 * previews are not echoed back: the field being edited already shows its own draft.
 */
export function useLiveStyles(): Live {
  return useSyncExternalStore(subscribePreview, () => live, () => live);
}
