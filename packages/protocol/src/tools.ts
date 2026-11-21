import { z } from 'zod';

const fileId = z.string().optional().describe('The file ID to operate on. Omit to use the file the user is viewing.');
const pageId = z.string().optional().describe('The page ID to operate on. Omit to use the active page; prefer explicit page IDs.');
const LINK_HINT = 'A node ID or a Markup link (markup://file/…/node/…) copied by the user.';
const nodeRef = z.string().describe(LINK_HINT);
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
    nodeId: nodeRef,
    depth: z.number().int().min(0).max(10).optional().describe('Maximum depth (default 3, max 10).'),
  }),
  get_children: tool('Get the direct children of a node with IDs, names, component types, child counts and positions.', { fileId, nodeId: nodeRef }),
  get_node_info: tool('Get details for one node: size, visibility, lock state, parent, children IDs, plain text content for text nodes, and position. ' + LINK_HINT, {
    fileId,
    nodeId: nodeRef,
  }),
  get_jsx: tool('Get the JSX of a node and its descendants, with inline styles (default) or Tailwind classes with inline fallback. ' + LINK_HINT, {
    fileId,
    nodeId: nodeRef,
    format: z.enum(['inline-styles', 'tailwind']).optional(),
    includeNodeIds: z.boolean().optional().describe('Add id attributes with node IDs (default true). Pass false for clean code.'),
    includeRootPositioning: z.boolean().optional().describe("Keep the root's canvas position (default false)."),
  }),
  get_computed_styles: tool('Get the computed CSS styles for one or more nodes, as a map of nodeId to CSS properties.', { fileId, nodeIds: z.array(z.string()).min(1) }),
  get_screenshot: tool('Capture a PNG screenshot of a node. Scale 1 (default) for layout checks, 2 to read small text.', {
    fileId,
    nodeId: nodeRef,
    scale: z.number().min(0.25).max(4).optional(),
  }),
  get_font_family_info: tool(
    "Get information about whether a font family is available in a file and all weights and styles in the family. This tool looks up fonts on the user's machine and Google Fonts. Each family lists groups of styles that share the same italicization, width, and variable axes.",
    { fileId, familyNames: z.array(z.string()).describe('Font family names to look up, e.g. ["Inter", "Roboto"].') },
  ),
  export: tool(
    "Export nodes as image or video files. Unless the user specifies, do not override the default export settings. Returns each export's file path. Raster output is limited to 16384 px on its longest side and 16,777,216 px in area: a larger scale is lowered to the largest that fits and the export reports the ratio used as clampedScale. Hidden or zero-size nodes are skipped and listed in skipped ({ nodeId, reason }); a single requested node that is hidden is an error.",
    {
      fileId,
      pageId: z.string().optional().describe('The page ID to export from when nodes is "nodes-with-exports-only". Omit to use the page the user is viewing.'),
      type: z.enum(['image', 'video']).optional().describe('The kind of export. Defaults to image.'),
      nodes: z.union([
        z.literal('nodes-with-exports-only').describe('Exports all nodes on the target page that already have export settings. Uses pageId when provided, otherwise the page the user is viewing.'),
        z
          .record(
            z.string(),
            z.array(
              z.object({
                format: z.enum(['avif', 'jpg', 'mp4', 'pdf', 'png', 'svg', 'webm', 'webp']),
                scale: z.string().regex(/^\d+(\.\d+)?(x|w|h|p)$/).describe('A multiplier like "2x", or a target size: "720p" (shortest side), "512w" (width) or "512h" (height).'),
                durationSeconds: z.number().min(1).max(300).optional().describe('Video length in seconds (default 10).'),
                pdfQuality: z.enum(['low', 'medium', 'high']).optional().describe('PDF image quality (default high).'),
                pdfResampling: z.enum(['detailed', 'basic']).optional().describe('PDF resampling (default detailed).'),
              }),
            ),
          )
          .describe('Map of node ID to export settings. Set to an empty array [] to export with default settings.'),
      ]),
    },
  ),
  export_combined_pdf: tool(
    'Export multiple nodes combined into a single PDF file, one page per node. Pages are auto-ordered by canvas position (top-to-bottom, then left-to-right). Use this instead of "export" when the user wants the nodes merged into one PDF rather than separate files. The quality and resampling used is the highest of any existing PDF export settings found on individual nodes.',
    { fileId, nodeIds: z.array(z.string()).min(1).describe('The nodes to combine, one PDF page each.') },
  ),
  get_fill_image: tool(
    'Extract the image data from a node that has an image fill. Returns the image as base64-encoded JPEG data optimized for AI consumption. Large images are automatically resized to fit within API size limits. The original image URL is included in the metadata if you need the full-quality source. Returns an error if the node does not exist, or a message if the node has no image fill, is an SVG (use get_jsx), or the image is still generating.',
    { fileId, nodeId: z.string() },
  ),
  find_nodes: tool(
    'Find nodes by computed style and/or text. filters are {styleName, styleValue} matchers combined with AND; both accept "*" wildcards, colors match by equivalence, and a literal color also finds token-bound usages. textValue matches text content case-insensitively, anchored, with "*" wildcards. nodeId (search scope): ' + LINK_HINT,
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
    'Write HTML into the design. Write incrementally: one visual group per call so the user watches progress. Rules: inline style="" only; flex, padding and gap for layout; no margin, display:inline, display:grid or HTML tables; border-box everywhere; <pre> for code. layer-name="Hero" names a layer. <x-markup-clone node-id="..." style="..."/> clones an existing node with overrides. Local images use markup-asset:///absolute/path. mode "insert-children" (default) adds children to the target; "replace" swaps the target. Omit targetNodeId to put a standalone component (a button, a card, a nav bar) straight on the page: each top-level element becomes its own artboard, with no empty frame around it, placed right of the last artboard; give it a pixel width. Use create_artboard only for full screens. targetNodeId: ' + LINK_HINT,
    {
      fileId,
      pageId: z.string().optional().describe('The page to place top-level elements on when targetNodeId is omitted. Omit to use the active page.'),
      html: z.string(),
      targetNodeId: nodeRef.optional(),
      mode: z.enum(['insert-children', 'replace']).optional(),
    },
  ),
  update_styles: tool(
    'Update styles on one or more nodes in a batch. Supports design tokens as CSS variables. Setting top/left on an artboard moves it on the canvas. Styles inert in the node context are dropped and returned under ignoredStyles. An empty string or null removes a property. nodeIds: ' + LINK_HINT,
    { fileId, updates: z.array(z.object({ nodeIds: z.array(nodeRef).min(1), styles: z.record(z.string(), z.union([styleValue, z.null()])) })).min(1) },
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
  update_pages: tool('Change the name and/or icon of one or more pages in the file. Does not switch which page the user is viewing. Supports batch updates. Icon is one of the fixed set, or null to restore the default.', {
    fileId,
    updates: z.array(z.object({ pageId: z.string(), name: z.string().optional(), icon: PAGE_ICON.nullable().optional() })).min(1),
  }),
  arrange_pages: tool(
    'Reorder the page list and add or remove dividers in one call. Pass the complete new order; the call is rejected without changes if it misses an item or lists an unknown or repeated ID, which also happens when pages were added or removed since you read the list. Pages are never deleted. Does not switch which page the user is viewing. Returns the resulting page list, including the IDs of new dividers.',
    {
      fileId,
      order: z.array(z.union([z.string(), z.object({ type: z.literal('divider') })])).describe('Complete new order: page or divider IDs, or { "type": "divider" } for a new divider.'),
      removeDividerIds: z.array(z.string()).optional().describe('IDs of dividers to remove; they must not appear in order.'),
    },
  ),
  list_comment_threads: tool(
    "List visible comment threads in the open file as compact summaries. A comment thread is a conversation pinned to a node: a first message plus reply messages, each with its own author, and an \"open\" or \"resolved\" workflow status. Lists only open (unresolved) threads by default. Use this first to discover relevant discussion, then call get_comment_thread for full replies. If you are tasked and fully addressing a thread's feedback, mark it done with set_comment_thread_status. Supports page, node, status, author, search, sort, and pagination filters. User ID filters accept \"current-user\" for the signed-in user. Deleted threads/messages are never returned.",
    {
      fileId,
      currentPageOnly: z.boolean().optional().describe('Only threads on the page the user is viewing.'),
      pageId: z.string().optional().describe('Only threads on this page.'),
      nodeId: z.string().optional().describe('Only threads pinned to this node.'),
      status: z.enum(['open', 'resolved', 'all']).optional().describe('Workflow status filter (default open).'),
      participantUserId: z.string().optional().describe('Only threads where this user wrote a message. Accepts "current-user".'),
      threadAuthorUserId: z.string().optional().describe('Only threads started by this user. Accepts "current-user".'),
      search: z.string().optional().describe('Case-insensitive text to find in message bodies.'),
      searchScope: z.enum(['first-message', 'all-messages']).optional().describe('Where to search (default all-messages).'),
      sortField: z.enum(['page', 'createdAt', 'updatedAt']).optional().describe('Sort field (default page: page order, then createdAt).'),
      sortDirection: z.enum(['asc', 'desc']).optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Page size (default 50, max 200).'),
      offset: z.number().int().min(0).optional(),
      previewLength: z.number().int().min(20).max(1000).optional().describe('Characters of the first message to include (default 240).'),
    },
  ),
  get_comment_thread: tool(
    'Get full details for one visible comment thread, including its open/resolved status, all reply messages, reactions, attachments (each with a public URL you can fetch to view the file), page context, and pinned node context. Works for any status. Call list_comment_threads first when you do not already know the commentThreadId. Deleted threads/messages are never returned.',
    { fileId, commentThreadId: z.string().min(1) },
  ),
  list_comment_thread_authors: tool(
    "List every user who has started a comment thread or written a visible message in the open file, with their user ID, display name, activity counts, and last activity time. Use this to resolve a person's name to a userId before filtering list_comment_threads by participantUserId or threadAuthorUserId. Deleted threads/messages are never counted.",
    { fileId, pageId: z.string().optional().describe('Only count activity on this page.') },
  ),
  set_comment_thread_status: tool(
    'Set the workflow status of one comment thread to "resolved" or "open". Resolve a thread once its feedback has been fully addressed in the design — this is how you mark review comments as done. Reopen a resolved thread if more work turns out to be needed.',
    { fileId, commentThreadId: z.string().min(1), status: z.enum(['open', 'resolved']) },
  ),
  list_resources: tool(
    'Lists files and folders. Each item has type "file" or "folder" and parentId, omitted for a top-level folder. Open files are listed first. `open` means the file is a desktop tab. `active` means that tab is in the foreground. Both apply only to files. `draft` means the item is in the user’s drafts; every local Markup file is a draft. Then files and folders recently updated. Pass parentId to list only what is inside one folder. Pass a higher limit until truncated is absent before treating the list as the whole tree.',
    {
      includeArchived: z.boolean().optional().describe('Optional. Also list archived files and folders, marked archived. Use to find IDs for unarchive_resources.'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of files and folders to return. Defaults to 50. Sorted by updatedAt, most recent first.'),
      parentId: z.string().optional().describe('Optional folder ID. Only list the files and folders directly inside this folder.'),
    },
  ),
  open_file: tool(
    'Opens a Markup file by its ID or URL as a desktop tab in the foreground. Optional pageId is applied only on the initial open; if the file is already open the page will not switch. Returns a get_basic_info response.',
    {
      fileId: z.string().min(1).describe('The Markup file ID to open. Accepts a bare ID, a /file/<id> route path, or the file URL (markup://file/<id>).'),
      pageId: z
        .string()
        .optional()
        .describe('Optional page ID to open. Only applied when the file is not already open; if the file is already open the current page is left unchanged so the user is not pulled away from what they are looking at. A page ID in a /file/<id>/<pageId> URL passed as fileId is also accepted.'),
    },
  ),
  create_file: tool(
    'Create a new Markup file and returns the new file’s ID, name, parentId, and URL. Pass parentId to create it inside a folder; otherwise it is created at the top level. To start working in the new file, call open_file with the returned ID.',
    {
      cloneFileId: z.string().optional().describe('Optional file ID to clone from. If provided, the new file is a copy of this one.'),
      name: z.string().optional().describe('Optional display name for the new file.'),
      parentId: z.string().optional().describe('Optional ID of the folder to create the new file in. Defaults to the top level. Use list_resources to find folder IDs.'),
    },
  ),
  create_folder: tool(
    'Create a new folder in the file browser and returns its ID, name, parentId, and URL. Pass parentId to nest it inside another folder; otherwise it is created at the top level. The stored name is trimmed and capped at 500 characters.',
    {
      name: z.string().optional().describe('Optional display name for the new folder. Defaults to "Untitled project".'),
      parentId: z.string().optional().describe('Optional ID of the folder to create the new folder in. Defaults to the top level. Use list_resources to find folder IDs.'),
    },
  ),
  rename_resource: tool(
    'Rename a file or folder. Sets the display name shown in the file browser and on its tab. Pass the file or folder ID. The stored name is trimmed and capped at 500 characters. An empty name leaves the current name unchanged. Returns the stored name and whether the resource is a file or a folder.',
    {
      resourceId: z.string().describe('The ID of the file or folder to rename.'),
      name: z.string().describe('The new display name for the file or folder.'),
    },
  ),
  move_resources: tool(
    'Move files and folders into another folder. A folder moves with everything inside it, so pass a folder or items inside it, not both. Every ID is checked first: if any of them cannot be moved, nothing is moved. Returns the moved items. Items already in the folder are listed separately and left as they are.',
    {
      resourceIds: z.array(z.string()).min(1).describe('The IDs of the files and folders to move. Use list_resources to find IDs.'),
      parentId: z.string().describe('The ID of the folder to move them into. Use list_resources to find folder IDs.'),
    },
  ),
  archive_resources: tool(
    'Archive files and folders. Archiving a folder also archives everything inside it. Archived items move to the Archive view in the file browser and are only returned by list_resources with includeArchived. Use unarchive_resources to restore them. Every ID is checked first: if any of them cannot be archived, nothing is archived. Returns the archived items.',
    { resourceIds: z.array(z.string()).min(1).describe('The IDs of the files and folders to archive. Use list_resources to find IDs.') },
  ),
  unarchive_resources: tool(
    'Unarchive files and folders. Unarchiving a folder also unarchives everything inside it. An item whose folder is still archived is moved to the top level, unless that folder is also being unarchived. Every ID is checked first: if any of them cannot be unarchived, nothing is unarchived. Returns the unarchived items with the parentId each one ended up in.',
    { resourceIds: z.array(z.string()).min(1).describe('The IDs of the archived files and folders to unarchive. Use list_resources with includeArchived to find IDs.') },
  ),
};

export type ToolName = keyof typeof tools;
export type ToolParams<T extends ToolName> = z.infer<(typeof tools)[T]['input']>;

export const ALL_TOOLS = Object.keys(tools) as ToolName[];

/** Tools only the editor can answer, because they need the rendered DOM or local UI state. */
export const DOM_TOOLS = ['get_selection', 'get_computed_styles', 'get_screenshot'] as const satisfies readonly ToolName[];
export type DomToolName = (typeof DOM_TOOLS)[number];

/** Tools about the file library and tabs. They never take a fileId: they act on the workspace. */
export const RESOURCE_TOOLS = [
  'list_resources',
  'open_file',
  'create_file',
  'create_folder',
  'rename_resource',
  'move_resources',
  'archive_resources',
  'unarchive_resources',
] as const satisfies readonly ToolName[];
export type ResourceToolName = (typeof RESOURCE_TOOLS)[number];

/** Tools about fonts. The editor answers them from the machine's fonts and the bundled Google Fonts catalog. */
export const FONT_TOOLS = ['get_font_family_info'] as const satisfies readonly ToolName[];
export type FontToolName = (typeof FONT_TOOLS)[number];

/** Tools that render nodes to files or images. The editor renders; `markup mcp` writes export files to disk. */
export const EXPORT_TOOLS = ['export', 'export_combined_pdf', 'get_fill_image'] as const satisfies readonly ToolName[];
export type ExportToolName = (typeof EXPORT_TOOLS)[number];

/** Tools the editor answers itself; everything else runs against the routed document with runDocTool. */
export const EDITOR_TOOLS = [...DOM_TOOLS, ...RESOURCE_TOOLS, ...FONT_TOOLS, ...EXPORT_TOOLS] as const satisfies readonly ToolName[];
export type EditorToolName = (typeof EDITOR_TOOLS)[number];
export type DocToolName = Exclude<ToolName, EditorToolName | 'get_guide'>;
