import * as Y from 'yjs';
import type { MarkupDoc } from './document';
import { MarkupError, type Actor } from './schema';

export interface LogEntry {
  seq: number;
  at: number;
  actor: Actor;
  summary: string;
  reverted: boolean;
  revertedBy?: string;
}

/** Origin for bookkeeping writes (log flags); never tracked by any undo manager. */
export const LOG_ORIGIN = Symbol('markup-log');

export const logArr = (doc: MarkupDoc) => doc.ydoc.getArray<Y.Map<unknown>>('log');

/** Shared types whose changes count as document history. */
export const historyScope = (doc: MarkupDoc) => [doc.nodes, doc.pagesArr, doc.ydoc.getArray('tokens')];

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function appendEntry(doc: MarkupDoc, actor: Actor, summary: string): number {
  const log = logArr(doc);
  const last = log.length ? (log.get(log.length - 1).get('seq') as number) : 0;
  const seq = last + 1;
  const m = new Y.Map<unknown>();
  m.set('seq', seq);
  m.set('at', Date.now());
  m.set('actor', { id: actor.id, kind: actor.kind, name: actor.name });
  m.set('summary', summary);
  m.set('reverted', false);
  log.push([m]);
  return seq;
}

export function readLog(doc: MarkupDoc): LogEntry[] {
  return logArr(doc)
    .toArray()
    .map((m) => {
      const e: LogEntry = {
        seq: m.get('seq') as number,
        at: m.get('at') as number,
        actor: m.get('actor') as Actor,
        summary: m.get('summary') as string,
        reverted: Boolean(m.get('reverted')),
      };
      const by = m.get('revertedBy');
      if (typeof by === 'string') e.revertedBy = by;
      return e;
    });
}

/**
 * Tracks every actor-attributed transaction (any plain-object origin) so a single
 * log entry can be reverted later. Stack items are tagged with their log seq.
 */
export class EntryHistory {
  private readonly um: Y.UndoManager;
  private pendingSeq: number | null = null;

  constructor(private readonly doc: MarkupDoc) {
    this.um = new Y.UndoManager(historyScope(doc), { trackedOrigins: new Set<unknown>([Object]), captureTimeout: 0 });
    this.um.on('stack-item-added', (event: { stackItem: { meta: Map<string, unknown> }; type: 'undo' | 'redo' }) => {
      if (event.type === 'undo' && this.pendingSeq !== null) event.stackItem.meta.set('seq', this.pendingSeq);
      this.pendingSeq = null;
    });
  }

  /** Called inside the actor's transaction, after its log entry was appended. */
  tag(seq: number) {
    this.pendingSeq = seq;
  }

  revert(actor: Actor, seq: number) {
    const entry = logArr(this.doc)
      .toArray()
      .find((m) => m.get('seq') === seq);
    if (!entry) throw new MarkupError('INVALID_ARGUMENT', `Log entry No. ${seq} does not exist.`);
    if (entry.get('reverted')) throw new MarkupError('INVALID_ARGUMENT', `Log entry No. ${seq} is already reverted.`);
    const stack = this.um.undoStack;
    const idx = stack.findIndex((item) => item.meta.get('seq') === seq);
    if (idx < 0) throw new MarkupError('INVALID_ARGUMENT', `Log entry No. ${seq} was made in another session and cannot be reverted here.`);
    const [item] = stack.splice(idx, 1);
    stack.push(item!);
    this.um.undo();
    this.um.redoStack.pop();
    this.doc.ydoc.transact(() => {
      entry.set('reverted', true);
      entry.set('revertedBy', actor.id);
    }, LOG_ORIGIN);
  }

  destroy() {
    this.um.destroy();
  }
}

/** Undo/redo limited to one actor's own operations; one op is one step. */
export class ActorUndo {
  private readonly um: Y.UndoManager;

  constructor(doc: MarkupDoc, actor: Actor) {
    this.um = new Y.UndoManager(historyScope(doc), { trackedOrigins: new Set<unknown>([actor]), captureTimeout: 0 });
  }

  undo(): boolean {
    return this.um.undo() !== null;
  }

  redo(): boolean {
    return this.um.redo() !== null;
  }

  canUndo(): boolean {
    return this.um.canUndo();
  }

  canRedo(): boolean {
    return this.um.canRedo();
  }

  destroy(): void {
    this.um.destroy();
  }
}
