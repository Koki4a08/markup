import type { Actor, ActorUndo, MarkupDoc, Styles } from '@markup/doc';
import type { Command } from './keyboard';
import type { Tool } from './canvas/tools';
import { pasteIntoDoc, readClipboard } from './paste';
import type { Point } from './canvas/viewport';
import { copyAsCode, copyAsPng, exportNodes } from './export/actions';

export interface CommandContext {
  doc: MarkupDoc;
  actor: Actor;
  undo: ActorUndo;
  rootId: string;
  getSelection(): string[];
  setSelection(ids: string[]): void;
  setTool(tool: Tool): void;
  zoomToFit(): void;
  zoomTo(zoom: number): void;
  startRename(id: string): void;
  collapseLayers(): void;
  /** Shows a short status message (copy and export results). */
  notify?(message: string): void;
  /** Centre of the visible canvas in world coordinates; where pasted artboards land. */
  viewportCenter?(): Point;
}

/** Selected ids that still exist and are not page roots, in document order of their parent. */
function selected(ctx: CommandContext): string[] {
  return ctx.getSelection().filter((id) => {
    const n = ctx.doc.getNode(id);
    return n && n.type !== 'root';
  });
}

function wrap(ctx: CommandContext, kind: 'frame' | 'flex') {
  const ids = selected(ctx);
  if (ids.length === 0) return;
  const { doc, actor } = ctx;
  const first = doc.requireNode(ids[0]!);
  const parentId = first.parentId!;
  const siblings = doc.requireNode(parentId).children;
  const ordered = ids.filter((id) => doc.requireNode(id).parentId === parentId).sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));
  const index = siblings.indexOf(ordered[0]!);
  const styles: Styles = kind === 'flex' ? { display: 'flex', flexDirection: 'column', gap: '0px' } : { width: 'fit-content', height: 'fit-content' };
  const wrapper = doc.batch(actor, `Wrapped ${ordered.length} node${ordered.length === 1 ? '' : 's'} in ${kind}`, () => {
    const [w] = doc.insertNodes(actor, parentId, [{ type: 'frame', name: kind === 'flex' ? 'Flex' : 'Frame', styles }], index);
    doc.moveNodes(actor, ordered.map((nodeId) => ({ nodeId, parentId: w! })));
    return w!;
  });
  ctx.setSelection([wrapper]);
}

/** Runs an async export or copy action and reports its outcome through ctx.notify; never throws. */
function report(ctx: CommandContext, failure: string, action: () => Promise<string>): void {
  action().then(
    (message) => message && ctx.notify?.(message),
    (e: unknown) => ctx.notify?.(`${failure}: ${e instanceof Error ? e.message : String(e)}`),
  );
}

export function runCommand(command: Command, ctx: CommandContext): void {
  const { doc, actor } = ctx;
  switch (command) {
    case 'tool:move':
      return ctx.setTool('move');
    case 'tool:frame':
      return ctx.setTool('frame');
    case 'tool:rect':
      return ctx.setTool('rect');
    case 'tool:text':
      return ctx.setTool('text');
    case 'tool:comment':
      return ctx.setTool('comment');
    case 'tool:hand':
      return ctx.setTool('hand');
    case 'undo':
      ctx.undo.undo();
      return;
    case 'redo':
      ctx.undo.redo();
      return;
    case 'delete': {
      const ids = selected(ctx);
      if (ids.length) doc.deleteNodes(actor, ids);
      return ctx.setSelection([]);
    }
    case 'duplicate': {
      const ids = selected(ctx);
      if (!ids.length) return;
      const results = doc.duplicateNodes(actor, ids.map((id) => ({ id })));
      return ctx.setSelection(results.map((r) => r.newId));
    }
    case 'selectChildren': {
      const children = selected(ctx).flatMap((id) => doc.requireNode(id).children);
      if (children.length) ctx.setSelection(children);
      return;
    }
    case 'selectParent': {
      const parents = [...new Set(selected(ctx).map((id) => doc.requireNode(id).parentId!))].filter((p) => doc.requireNode(p).type !== 'root');
      return ctx.setSelection(parents);
    }
    case 'rename': {
      const [id] = selected(ctx);
      if (id) ctx.startRename(id);
      return;
    }
    case 'toggleHidden': {
      const ids = selected(ctx);
      if (ids.length) doc.setFlags(actor, ids, { hidden: !ids.every((id) => doc.requireNode(id).hidden) });
      return;
    }
    case 'toggleLocked': {
      const ids = selected(ctx);
      if (ids.length) doc.setFlags(actor, ids, { locked: !ids.every((id) => doc.requireNode(id).locked) });
      return;
    }
    case 'zoomToFit':
      return ctx.zoomToFit();
    case 'zoomTo100':
      return ctx.zoomTo(1);
    case 'wrapInFrame':
      return wrap(ctx, 'frame');
    case 'wrapInFlex':
      return wrap(ctx, 'flex');
    case 'collapseLayers':
      return ctx.collapseLayers();
    case 'exportSelection': {
      const ids = selected(ctx);
      if (ids.length) report(ctx, 'Could not export', async () => {
        const n = await exportNodes(doc, ids);
        return n ? `Exported ${n} file${n === 1 ? '' : 's'}` : '';
      });
      return;
    }
    case 'copyPng': {
      const ids = selected(ctx);
      if (ids.length) report(ctx, 'Could not copy', () => copyAsPng(doc, ids));
      return;
    }
    case 'pasteOnTop':
    case 'pasteToReplace':
      report(ctx, 'Could not paste', async () => {
        const data = await readClipboard();
        const mode = command === 'pasteOnTop' ? 'on-top' : 'replace';
        const ids = await pasteIntoDoc(doc, actor, data, { selection: ctx.getSelection(), rootId: ctx.rootId, viewportCenter: ctx.viewportCenter?.() ?? { x: 0, y: 0 }, mode });
        if (ids.length) ctx.setSelection(ids);
        return ids.length ? '' : 'Nothing to paste.';
      });
      return;
    case 'copyReact':
    case 'copyTailwind': {
      const ids = selected(ctx);
      if (ids.length) report(ctx, 'Could not copy', () => copyAsCode(doc, ids, command === 'copyReact' ? 'inline-styles' : 'tailwind'));
      return;
    }
  }
}
