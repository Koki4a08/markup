export type NodeType = 'frame' | 'text' | 'image' | 'svg';

export type StyleValue = string | number;
export type Styles = Record<string, StyleValue>;

export interface Actor {
  id: string;
  kind: 'human' | 'agent';
  name: string;
}

export interface MarkupNode {
  id: string;
  type: NodeType | 'root';
  name: string;
  parentId: string | null;
  children: string[];
  styles: Styles;
  text?: string;
  src?: string;
  svg?: string;
  locked: boolean;
  hidden: boolean;
}

export interface NodeSpec {
  type: NodeType;
  name?: string;
  styles?: Styles;
  text?: string;
  src?: string;
  svg?: string;
  children?: NodeSpec[];
  cloneOf?: { nodeId: string; styles?: Styles };
}

export const PAGE_ICONS = [
  'arrow',
  'padlock',
  'check',
  'cross',
  'info',
  'question',
  'design',
  'vector',
  'images',
  'table',
  'presentation',
  'blueprint',
  'swatches',
  'bar-chart',
  'line-chart',
  'pie-chart',
  'paper',
] as const;

export type PageIcon = (typeof PAGE_ICONS)[number];

export type PageEntry =
  | { type: 'page'; id: string; name: string; icon: PageIcon | null; rootId: string }
  | { type: 'divider'; id: string };

export type ErrorCode =
  | 'NODE_NOT_FOUND'
  | 'PAGE_NOT_FOUND'
  | 'INVALID_PARENT'
  | 'CYCLE'
  | 'IS_ROOT'
  | 'INVALID_ORDER'
  | 'TOKEN_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'INVALID_PARAMS'
  | 'UNSUPPORTED';

export class MarkupError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'MarkupError';
    this.code = code;
  }
}
