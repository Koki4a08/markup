import { useSyncExternalStore } from 'react';
import type { Viewport } from './viewport';

/**
 * Small external stores for high-frequency canvas state (viewport, drag ticks, the draw preview). Only the
 * components that draw from them subscribe, so a wheel, pan or drag frame never re-renders the editor shell.
 */
export class ValueStore<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}

  get = (): T => this.value;

  set = (next: T | ((prev: T) => T)): void => {
    const value = typeof next === 'function' ? (next as (prev: T) => T)(this.value) : next;
    if (Object.is(value, this.value)) return;
    this.value = value;
    this.listeners.forEach((l) => l());
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export type ViewportStore = ValueStore<Viewport>;

/** A counter bumped while a gesture previews a move or resize; bumps coalesce to one per animation frame. */
export class TickStore {
  private value = 0;
  private frame = 0;
  private listeners = new Set<() => void>();

  get = (): number => this.value;

  /** Bumps on the next animation frame; repeated calls in the same frame notify once. */
  bump = (): void => {
    if (this.frame) return;
    if (typeof requestAnimationFrame !== 'function') return this.bumpNow();
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.bumpNow();
    });
  };

  /** Bumps right away, dropping a pending frame bump (gesture end). */
  bumpNow = (): void => {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.value++;
    this.listeners.forEach((l) => l());
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useStore<T>(store: ValueStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useTick(store: TickStore | undefined): number {
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.get ?? zero, store?.get ?? zero);
}

/** Zoom as a whole percentage; re-renders only when that number changes. */
export function useZoomPercent(store: ViewportStore): number {
  const read = () => Math.round(store.get().zoom * 100);
  return useSyncExternalStore(store.subscribe, read, read);
}

const noSubscribe = () => () => {};
const zero = () => 0;
