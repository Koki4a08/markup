import { z } from 'zod';

const fileId = z.string().optional().describe('The file ID to operate on. Omit to use the file the user is viewing.');
const pageId = z.string().optional().describe('The page ID to operate on. Omit to use the active page; prefer explicit page IDs.');
const styleValue = z.union([z.string(), z.number()]);
const styles = z.record(z.string(), styleValue);

export const TOKEN_TYPE = z.enum(['breakpoint', 'color', 'container', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'opacity', 'radius', 'spacing']);
export const PAGE_ICON = z.enum(['arrow', 'padlock', 'check', 'cross', 'info', 'question', 'design', 'vector', 'images', 'table', 'presentation', 'blueprint', 'swatches', 'bar-chart', 'line-chart', 'pie-chart', 'paper']);

const tool = <S extends z.ZodRawShape>(description: string, shape: S) => ({ description, input: z.object(shape) });

export const tools = {
  get_guide: tool('Read a detailed guide. Call with topic "markup-mcp-instructions" before using other Markup tools. Other topics: "mobile-status-bar".', {
    topic: z.string(),
  }),
  get_basic_info: tool(
    'Get essential context about the current design: file name, page, node count, artboards with dimensions, font families used, and a compact list of design tokens. Call this first. worldX/worldY are world positions; pages lists pages and dividers in display order, with isActive on the page the user sees.',
    { fileId, pageId },
  ),
  get_selection: tool('Get the nodes the user has selected: IDs, names, component types, size, and the artboard each belongs to.', { fileId }),
  get_tree_summary: tool('Get a compact indented text summary of a node subtree: type, name, ID and size per node. Much cheaper than get_jsx for orientation.', {
    fileId,
    nodeId: z.string(),
    depth: z.number().int().min(0).max(10).optional().describe('Maximum depth (default 3, max 10).'),
  }),
  get_children: tool('Get the direct children of a node with IDs, names, component types, child counts and positions.', { fileId, nodeId: z.string() }),
  get_node_info: tool('Get details for one node: size, visibility, lock state, parent, children IDs, plain text content for text nodes, and position.', {
    fileId,
    nodeId: z.string(),
  }),
  get_jsx: tool('Get the JSX of a node and its descendants, with inline styles (default) or Tailwind classes with inline fallback.', {
    fileId,
    nodeId: z.string(),
    format: z.enum(['inline-styles', 'tailwind']).optional(),
    includeNodeIds: z.boolean().optional().describe('Add id attributes with node IDs (default true). Pass false for clean code.'),
    includeRootPositioning: z.boolean().optional().describe("Keep the root's canvas position (default false)."),
  }),
  get_computed_styles: tool('Get the computed CSS styles for one or more nodes, as a map of nodeId to CSS properties.', { fileId, nodeIds: z.array(z.string()).min(1) }),
  get_screenshot: tool('Capture a PNG screenshot of a node. Scale 1 (default) for layout checks, 2 to read small text.', {
    fileId,
    nodeId: z.string(),
    scale: z.number().min(0.25).max(4).optional(),
  }),
  find_nodes: tool(
    'Find nodes by computed style and/or text. filters are {styleName, styleValue} matchers combined with AND; both accept "*" wildcards, colors match by equivalence, and a literal color also finds token-bound usages. textValue matches text content case-insensitively, anchored, with "*" wildcards.',
    {
      fileId,
      filters: z.array(z.object({ styleName: z.string().optional(), styleValue: z.string().optional() })).min(1).optional(),
      textValue: z.string().optional(),
      nodeId: z.string().optional(),
      pageId: z.string().optional(),
    },
  ),
  create_artboard: tool(
    'Create a new artboard (top-level frame), placed in the next empty spot 80px right of the last artboard. Defaults to display flex, column. Default sizes: Desktop 1440x900, Tablet 768x1024, Mobile 390x844. When content clips, switch height to fit-content with update_styles.',
    {
      fileId,
      pageId,
      name: z.string(),
      styles: styles.and(z.object({ width: z.string(), height: z.string() })).describe('CSS styles, camelCase. width and height are required whole-pixel values.'),
    },
  ),
  write_html: tool(
    'Write HTML into the design. Write incrementally: one visual group per call so the user watches progress. Rules: inline style="" only; flex, padding and gap for layout; no margin, display:inline, display:grid or HTML tables; border-box everywhere; <pre> for code. layer-name="Hero" names a layer. <x-markup-clone node-id="..." style="..."/> clones an existing node with overrides. Local images use markup-asset:///absolute/path. mode "insert-children" adds children to the target; "replace" swaps the target.',
    { fileId, html: z.string(), targetNodeId: z.string(), mode: z.enum(['insert-children', 'replace']) },
  ),
  update_styles: tool(
    'Update styles on one or more nodes in a batch. Supports design tokens as CSS variables. Setting top/left on an artboard moves it on the canvas. Styles inert in the node context are dropped and returned under ignoredStyles. An empty string or null removes a property.',
    { fileId, updates: z.array(z.object({ nodeIds: z.array(z.string()).min(1), styles: z.record(z.string(), z.union([styleValue, z.null()])) })).min(1) },
  ),
  set_text_content: tool(
    'Replace the inner HTML of Text nodes, keeping ID and layout. Inline formatting supported: color, font, font-size, letter-spacing, line-height, text-transform, text-decoration, -webkit-text-stroke, and gradients only with background-clip: text.',
    { fileId, updates: z.array(z.object({ nodeId: z.string(), html: z.string() })).min(1) },
  ),
  duplicate_nodes: tool('Deep-clone nodes. Duplicated artboards land in a blank area. Returns new IDs plus a descendantIdMap from every original descendant ID to its clone.', {
    fileId,
    nodes: z.array(z.object({ id: z.string(), parentId: z.string().optional() })).min(1),
  }),
  move_nodes: tool(
    "Move or reparent nodes, keeping IDs. Each move is {nodeId, before} / {nodeId, after} (sibling-relative) or {nodeId, parentId, index?} (parentId 'root' = the page root). Moves apply in order. Returns resolved parent and index per move, plus affectedParents with their new child lists.",
    {
      fileId,
      moves: z
        .array(
          z.union([
            z.object({ nodeId: z.string(), before: z.string() }),
            z.object({ nodeId: z.string(), after: z.string() }),
            z.object({ nodeId: z.string(), parentId: z.string(), index: z.number().int().min(0).optional() }),
          ]),
        )
        .min(1),
    },
  ),
  delete_nodes: tool('Delete nodes and all their descendants. Verify the parent with get_node_info before deleting a node you think is misplaced.', {
    fileId,
    nodeIds: z.array(z.string()).min(1),
  }),
  rename_nodes: tool('Rename layers in the layer tree (names over 50 characters are truncated).', {
    fileId,
    updates: z.array(z.object({ nodeId: z.string(), name: z.string() })).min(1),
  }),
  finish_working_on_nodes: tool('MUST call when done working: removes your working indicator from artboards. Pass artboard IDs to release only those.', {
    fileId,
    nodeIds: z.array(z.string()).optional(),
  }),
  get_tokens: tool('List design tokens. format "json" (default), "css" (:root block) or "tailwind" (Tailwind v4 @theme block). Filter by types and a glob namePattern.', {
    fileId,
    format: z.enum(['json', 'css', 'tailwind']).optional(),
    namePattern: z.string().optional(),
    types: z.array(TOKEN_TYPE).optional(),
  }),
  create_tokens: tool(
    'Create design tokens; each needs type, name (--css-variable) and value. Alias another token with var(--other). Define semantic colors before palette colors; other types from smallest value up. Prefer reusing tokens.',
    {
      fileId,
      tokens: z
        .array(z.object({ type: TOKEN_TYPE, name: z.string(), value: styleValue, description: z.string().max(1024).optional() }))
        .min(1),
    },
  ),
  set_tokens: tool('Update, rename (newName) or delete (delete: true) tokens by full CSS variable name. Renames rewrite every var() reference.', {
    fileId,
    tokens: z
      .array(z.object({ name: z.string(), newName: z.string().optional(), value: styleValue.optional(), description: z.string().max(1024).optional(), delete: z.boolean().optional() }))
      .min(1),
  }),
  create_page: tool('Create a page after the one the user is viewing and return its ID. Optional icon from a fixed set.', { fileId, name: z.string().optional(), icon: PAGE_ICON.optional() }),
};

export type ToolName = keyof typeof tools;
export type ToolParams<T extends ToolName> = z.infer<(typeof tools)[T]['input']>;

export const PHASE1_TOOLS = Object.keys(tools) as ToolName[];

/** Tools only the editor can answer, because they need the rendered DOM or local UI state. */
export const DOM_TOOLS = ['get_selection', 'get_computed_styles', 'get_screenshot'] as const satisfies readonly ToolName[];
export type DomToolName = (typeof DOM_TOOLS)[number];
export type DocToolName = Exclude<ToolName, DomToolName | 'get_guide'>;
