import type { MarkupDoc } from '@markup/doc';
import { layoutTick } from './layoutTick';

/**
 * Heavy layers (a big artboard when a file opens, a large pasted component) mount one at a time, each in a
 * React transition, with a shimmer placeholder until then. Rendering thousands of DOM nodes in one
 * synchronous commit froze the whole app; queued, the window keeps painting and answering input between them.
 */

/** A subtree with at least this many layers below it mounts deferred. */
export const HEAVY_SUBTREE = 250;

/**
 * Layers one synchronous render may mount before the rest wait behind placeholders. A page of many
 * medium artboards (each under HEAVY_SUBTREE) would otherwise still mount all at once and freeze.
 */
export const SYNC_BUDGET = 600;

let spent = 0;
let refillPending = false;

/**
 * Whether a layer about to mount should wait behind a placeholder: it is heavy itself, or the current
 * task already mounted SYNC_BUDGET layers. The budget refills once the task ends.
 */
export function shouldDefer(doc: MarkupDoc, id: string): boolean {
  const size = descendantCount(doc, id, HEAVY_SUBTREE) + 1;
  if (size > HEAVY_SUBTREE || spent + size > SYNC_BUDGET) return true;
  spent += size;
  if (!refillPending) {
    refillPending = true;
    setTimeout(() => {
      spent = 0;
      refillPending = false;
    }, 0);
  }
  return false;
}

/** Whether the node has at least HEAVY_SUBTREE descendants. */
export function isHeavy(doc: MarkupDoc, id: string, limit = HEAVY_SUBTREE): boolean {
  return descendantCount(doc, id, limit) >= limit;
}

/** Descendants of the node, counted up to limit. Walks the Yjs maps and stops at the limit. */
function descendantCount(doc: MarkupDoc, id: string, limit: number): number {
  let count = 0;
  const stack = [id];
  while (stack.length) {
    const node = doc.nodes.get(stack.pop()!);
    const children = node?.get('children') as { toArray(): string[] } | undefined;
    if (!children) continue;
    for (const child of children.toArray()) {
      if (++count >= limit) return count;
      stack.push(child);
    }
  }
  return count;
}

export interface RevealJob {
  run(): void;
  state: 'queued' | 'running' | 'done';
}

const queue: RevealJob[] = [];
let running: RevealJob | null = null;
let idleWaiters: (() => void)[] = [];

function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
    return;
  }
  running = job;
  job.state = 'running';
  job.run();
}

/** Queues run (which starts the mount); the next job starts only after finishReveal for this one. */
export function scheduleReveal(run: () => void): RevealJob {
  const job: RevealJob = { run, state: 'queued' };
  queue.push(job);
  pump();
  return job;
}

/** The job's layer committed, or unmounted before it did: the next one may start after a frame. */
export function finishReveal(job: RevealJob): void {
  if (job.state === 'done') return;
  if (job.state === 'queued') queue.splice(queue.indexOf(job), 1);
  job.state = 'done';
  if (running === job) {
    running = null;
    // Labels, backdrops and the selection re-measure: the layer took the placeholder's place.
    layoutTick.bump();
    // A macrotask between reveals lets the browser paint and handle input.
    setTimeout(pump, 0);
  } else if (!running && !queue.length) pump();
}

/** Resolves once no deferred layer is waiting to mount, so agent tools can measure what was just written. */
export function revealsSettled(): Promise<void> {
  if (!running && !queue.length) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}
