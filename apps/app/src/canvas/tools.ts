export type Tool = 'move' | 'frame' | 'rect' | 'text' | 'hand' | 'comment';

export const TOOLS: { id: Tool; label: string; shortcut: string }[] = [
  { id: 'move', label: 'Move', shortcut: 'V' },
  { id: 'frame', label: 'Frame', shortcut: 'F' },
  { id: 'rect', label: 'Rectangle', shortcut: 'R' },
  { id: 'text', label: 'Text', shortcut: 'T' },
  { id: 'hand', label: 'Hand', shortcut: 'H' },
  { id: 'comment', label: 'Comment', shortcut: 'C' },
];
