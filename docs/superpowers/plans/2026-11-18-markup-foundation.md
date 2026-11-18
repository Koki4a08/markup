# Markup Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working Markup phase 1: a Yjs document model, a browser/desktop editor that renders it as real DOM, and a `markup mcp` stdio server through which an agent can read and write the open file with the core Paper-compatible tools.

**Architecture:** `@markup/doc` owns the CRDT document and every pure operation (node ops, HTML import, JSX export, tokens, history), so all of it is tested in Node. `@markup/protocol` holds the bridge message types and the zod schemas of every MCP tool, shared by both ends. `markup mcp` is a thin stdio MCP server that forwards tool calls over a localhost WebSocket hub to the editor, which runs doc tools through `@markup/doc` and DOM tools (screenshot, computed styles, selection) itself.

**Tech Stack:** pnpm workspaces, TypeScript (strict), Vitest, Yjs, y-indexeddb, parse5, zod, ws, @modelcontextprotocol/sdk, React + Vite, html-to-image, Tauri 2.

**Spec:** `PRODUCT.md` (product truth and decisions) and the feature list artifact https://claude.ai/artifact/SNqrCKg8QidtJfggPxJWPy — sections 2, 8, 9, 18, 19, 22 govern this plan.

## Global Constraints

- Node 24, pnpm 10, TypeScript `strict: true`, ESM everywhere (`"type": "module"`).
- Dependencies: latest stable at install time; no other runtime deps than the stack above without a reason in the commit message.
- MCP tool names, parameter names and semantics mirror Paper's (feature list section 18) exactly; only the product names change: `x-paper-clone` → `x-markup-clone`, `paper-asset://` → `markup-asset://`, `paper` CLI → `markup`.
- Bridge hub listens on `127.0.0.1:29980` only (never `0.0.0.0`).
- No MCP call limits or metering anywhere.
- Every document mutation runs in `ydoc.transact(fn, actor)` with an `Actor` origin, so history and undo can attribute it.
- UI is deliberately neutral (system font, greys, one focus blue `#2563eb`) — the visual world is undecided; no branding work in this plan.
- Work on branch `feat/foundation`, never on `master`.

## Review Focus

1. **Agent and human edit the same node at once** — both edits land, and the human's ⌘Z reverts only the human's change (Task 6 test `undo reverts only own actor`).
2. **write_html with CSS outside the dialect** (`margin`, `display:grid`, `display:inline`, `<table>`) — content still imports, banned properties are dropped and listed in `ignoredStyles`, `var(--token)` values survive (Task 3 tests).
3. **Editor not running, or it closes mid-call** — the tool returns error code `NO_EDITOR` / `EDITOR_DISCONNECTED` with a sentence telling the user to open Markup, never hangs past 30 s (Task 8 tests).
4. **Non-Latin text** (Cyrillic, CJK, emoji) — survives write_html → get_jsx byte-for-byte (Task 4 test `round-trips non-latin text`).
5. **Port 29980 held by a non-Markup process** — `markup mcp` exits with a clear message naming the port instead of crashing on the handshake (Task 8 test `foreign port owner`).

---

## File Structure

```
package.json                    workspace scripts: test, build, dev
pnpm-workspace.yaml             packages/*, apps/*
tsconfig.base.json              strict ESM base
vitest.workspace.ts             runs every package's tests
packages/doc/src/
  schema.ts                     NodeType, MarkupNode, NodeSpec, Actor, PageEntry, MarkupError
  document.ts                   MarkupDoc: Yjs layout, pages, reads
  ops.ts                        node mutations (insert/replace/update/move/delete/duplicate/rename/working)
  styles.ts                     dialect rules: normalizeStyles(), BANNED
  html-import.ts                parseHtml(html) -> NodeSpec[]
  jsx-export.ts                 toJsx(), toTailwindClasses()
  query.ts                      treeSummary(), findNodes()
  tokens.ts                     token CRUD + css/tailwind output
  history.ts                    ActionLog + ActorUndo
  tools.ts                      runDocTool() dispatcher
  index.ts
packages/protocol/src/
  bridge.ts                     message types, BRIDGE_PORT, error codes
  tools.ts                      zod schemas + descriptions for every tool
  index.ts
packages/mcp/src/
  cli.ts                        `markup` bin: `markup mcp`
  hub.ts                        WebSocket hub (routing editor <-> agents)
  server.ts                     MCP server: registers tools, forwards via hub
apps/app/
  index.html, vite.config.ts
  src/main.tsx, App.tsx
  src/store/                    doc provider, useNode/useChildren hooks, persistence
  src/canvas/                   Canvas, NodeView, SelectionOverlay, viewport math
  src/panels/                   LayersPanel, Inspector, AgentLog
  src/bridge/                   bridge client + DOM tool handlers
  src-tauri/                    Tauri 2 shell
```

---

### Task 1: Workspace and document skeleton

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore` (node_modules, dist, target, .impeccable/mocks)
- Create: `packages/doc/package.json`, `packages/doc/tsconfig.json`, `packages/doc/src/schema.ts`, `packages/doc/src/document.ts`, `packages/doc/src/index.ts`
- Test: `packages/doc/test/document.test.ts`

**Interfaces:**
- Produces:
  - `type NodeType = 'frame' | 'text' | 'image' | 'svg'` (an artboard is a `frame` whose parent is a page root; a rectangle is a `frame` with no children)
  - `interface Actor { id: string; kind: 'human' | 'agent'; name: string }`
  - `interface MarkupNode { id: string; type: NodeType | 'root'; name: string; parentId: string | null; children: string[]; styles: Record<string, string | number>; text?: string; src?: string; svg?: string; locked: boolean; hidden: boolean }` (plain snapshot)
  - `interface NodeSpec { type: NodeType; name?: string; styles?: Record<string, string | number>; text?: string; src?: string; svg?: string; children?: NodeSpec[]; cloneOf?: { nodeId: string; styles?: Record<string, string | number> } }`
  - `type PageEntry = { type: 'page'; id: string; name: string; icon: PageIcon | null; rootId: string } | { type: 'divider'; id: string }`
  - `type PageIcon` = the 17 names in feature list section 19
  - `class MarkupError extends Error { constructor(code: ErrorCode, message: string) }`, `type ErrorCode = 'NODE_NOT_FOUND' | 'PAGE_NOT_FOUND' | 'INVALID_PARENT' | 'CYCLE' | 'IS_ROOT' | 'INVALID_ORDER' | 'TOKEN_NOT_FOUND' | 'INVALID_ARGUMENT'`
  - `class MarkupDoc { constructor(opts?: { ydoc?: Y.Doc; name?: string }); readonly ydoc: Y.Doc; readonly fileId: string; name: string; pages(): PageEntry[]; createPage(actor: Actor, opts?: { name?: string; icon?: PageIcon }): string; getNode(id: string): MarkupNode | undefined; requireNode(id: string): MarkupNode; pageOfNode(nodeId: string): string; nodeCount(): number }`
  - Yjs layout (other tasks write through it): `ydoc.getMap('meta')` {fileId, name}; `ydoc.getArray<Y.Map>('pages')`; `ydoc.getMap<Y.Map>('nodes')` keyed by id, each node map has `type,name,parentId,locked,hidden,text,src,svg` plus `children: Y.Array<string>` and `styles: Y.Map`. IDs from `nanoid(10)`.

- [ ] **Step 1: Write the failing tests** in `document.test.ts`:
  - `new doc has one page named "Page 1" with a root node` → `pages()` length 1, `getNode(rootId).type === 'root'`, `nodeCount() === 1`
  - `createPage adds after existing and returns id` → name defaults to `"Page 2"`, icon `null`
  - `two docs sharing updates converge` → apply `Y.encodeStateAsUpdate(a.ydoc)` to `b.ydoc`, `b.pages()` deep-equals `a.pages()`
  - `requireNode throws NODE_NOT_FOUND` → `expect(() => doc.requireNode('nope')).toThrow(expect.objectContaining({ code: 'NODE_NOT_FOUND' }))`
- [ ] **Step 2: Run** `pnpm --filter @markup/doc test` — expected FAIL (module missing).
- [ ] **Step 3: Implement** workspace files, `schema.ts`, `document.ts` (constructor seeds meta + first page only when the ydoc is empty, so loading an existing ydoc does not add a page).
- [ ] **Step 4: Run** `pnpm test` from root — expected PASS.
- [ ] **Step 5: Commit** `git checkout -b feat/foundation` (first task only), then `git add -A && git commit -m "feat(doc): workspace and document skeleton"`.

---

### Task 2: Node operations

**Files:**
- Create: `packages/doc/src/ops.ts`; Modify: `packages/doc/src/document.ts` (methods delegate to ops), `index.ts`
- Test: `packages/doc/test/ops.test.ts`

**Interfaces:**
- Consumes: Task 1 types and Yjs layout.
- Produces (methods on `MarkupDoc`, each one transaction with `actor` as origin):
  - `insertNodes(actor, parentId: string, specs: NodeSpec[], index?: number): string[]` — returns ids of the top-level inserted nodes
  - `replaceNode(actor, targetId: string, specs: NodeSpec[]): string[]`
  - `updateStyles(actor, updates: { nodeIds: string[]; styles: Record<string, string | number | null> }[]): { ignoredStyles: Record<string, string[]> }` — `null` or `''` removes a property; filtering comes from Task 3's `normalizeStyles`, so in this task pass styles through and return `{}` lists
  - `setText(actor, updates: { nodeId: string; html: string }[]): void` — only on `text` nodes, else `INVALID_ARGUMENT`
  - `moveNodes(actor, moves: Move[]): { results: { nodeId: string; parentId: string; index: number }[]; affectedParents: Record<string, string[]> }`, `type Move = { nodeId: string; before: string } | { nodeId: string; after: string } | { nodeId: string; parentId: string | 'root'; index?: number }`
  - `deleteNodes(actor, ids: string[]): void`
  - `duplicateNodes(actor, items: { id: string; parentId?: string }[]): { sourceId: string; newId: string; descendantIdMap: Record<string, string> }[]`
  - `renameNodes(actor, updates: { nodeId: string; name: string }[]): void` — names truncated to 50 chars
  - `setWorking(actor, artboardIds: string[] | 'all', on: boolean): void` — stored in `ydoc.getMap('working')` as artboardId → actor
  - `artboardOf(nodeId: string): string | null`

- [ ] **Step 1: Write failing tests:**
  - `insertNodes builds nested tree` → spec with 2 children → parent `children` length 2, each child `parentId` correct
  - `index clamps to [0, childCount]` → index 99 appends
  - `moveNodes before/after/parentId keeps ids` and returns `affectedParents` for source and destination
  - `moveNodes rejects cycle` → moving a frame under its own child throws `CYCLE`; `'root'` resolves to the node's page root
  - `moveNodes is sequential` → second move sees first
  - `cannot move or delete root` → `IS_ROOT`
  - `deleteNodes removes descendants` → `nodeCount()` drops by subtree size
  - `duplicateNodes maps every descendant` → `descendantIdMap` has one entry per descendant, all new ids distinct
  - `duplicated artboard is placed clear of the source` → new `left` ≥ source `left + width + 80`
  - `renameNodes truncates to 50`
  - `updateStyles null removes property`
  - `setText on frame throws INVALID_ARGUMENT`
  - `every op records actor as transaction origin` → `ydoc.on('afterTransaction', t => origins.push(t.origin))`, all equal the actor object
- [ ] **Step 2: Run** `pnpm --filter @markup/doc test ops` — FAIL.
- [ ] **Step 3: Implement** `ops.ts`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(doc): node operations with actor origins`.

---

### Task 3: Style dialect and HTML import

**Files:**
- Create: `packages/doc/src/styles.ts`, `packages/doc/src/html-import.ts`; Modify: `ops.ts` (`updateStyles` uses `normalizeStyles`), `index.ts`
- Test: `packages/doc/test/html-import.test.ts`, `packages/doc/test/styles.test.ts`

**Interfaces:**
- Consumes: `NodeSpec`, `MarkupDoc.insertNodes/replaceNode/getNode`.
- Produces:
  - `normalizeStyles(styles: Record<string, string | number | null>, ctx: { type: NodeType | 'root'; isArtboard: boolean }): { styles: Record<string, string | number | null>; ignored: string[] }` — keys to camelCase; drops `margin*`, `display: grid|inline|inline-grid|table*`, `grid*`; drops text-only props (`fontSize`, `fontFamily`, `fontWeight`, `lineHeight`, `letterSpacing`, `textAlign`, `color`) on non-text nodes (inert, Paper returns them under ignoredStyles); artboards default `display:flex; flexDirection:column`
  - `parseHtml(html: string): { specs: NodeSpec[]; ignored: string[] }` — parse5 fragment; element with only text/inline children (`span`, `b`, `i`, `em`, `strong`, `a`, `br`) → one `text` node whose `text` is its inner HTML; `img` → `image` (`src`, `markup-asset://` kept verbatim); `svg` → `svg` with outer HTML; every other element (incl. `table`, `tr`, `td`) → `frame`; `layer-name` attr → `name`, else name from tag/text (first 30 chars of text for text nodes); `<x-markup-clone node-id style>` → `cloneOf`
  - `MarkupDoc.writeHtml(actor, targetNodeId: string, html: string, mode: 'insert-children' | 'replace'): { nodeIds: string[]; ignoredStyles: string[] }` — resolves `cloneOf` by deep-copying the referenced node with style overrides

- [ ] **Step 1: Write failing tests:**
  - `div with inline styles becomes frame` → `{display:'flex', gap:'24px'}` on the spec
  - `margin and display grid are dropped and reported` → `ignored` contains `margin` and `display`
  - `table imports as frames` → no throw, rows become frames
  - `var(--color-primary) survives` → `styles.backgroundColor === 'var(--color-primary)'`
  - `paragraph with spans becomes one rich text node` → `text === 'Hi <b>there</b>'`
  - `layer-name sets name`
  - `x-markup-clone deep-copies with override` → clone of a 2-child frame has 2 new children, overridden `width`
  - `font props on a frame are ignored`
  - `unknown clone node-id throws NODE_NOT_FOUND`
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(doc): html import with style dialect`.

---

### Task 4: JSX export and queries

**Files:**
- Create: `packages/doc/src/jsx-export.ts`, `packages/doc/src/query.ts`
- Test: `packages/doc/test/jsx-export.test.ts`, `packages/doc/test/query.test.ts`

**Interfaces:**
- Consumes: `MarkupDoc.getNode`, `writeHtml` (for fixtures).
- Produces:
  - `toJsx(doc: MarkupDoc, nodeId: string, opts?: { format?: 'inline-styles' | 'tailwind'; includeNodeIds?: boolean; includeRootPositioning?: boolean }): string` — defaults `inline-styles`, `includeNodeIds: true`, `includeRootPositioning: false` (strips root `position/top/left/right/bottom`); frames → `<div>`, text → `<p>` with inner HTML kept, image → `<img>`, svg verbatim; 2-space indentation
  - `toTailwindClasses(styles): { className: string; rest: Record<string, string | number> }` — maps display flex, flexDirection, alignItems, justifyContent, flexWrap, position, overflow hidden, and px values of gap/padding*/width/height/borderRadius/fontSize/fontWeight to classes (`gap-[24px]`, `p-[64px]`, `w-[1440px]`, `bg-[#0F3B4C]`, `text-[#fff]`, `rounded-[12px]`, `font-[600]`); anything unmapped stays in `rest` → inline `style`
  - `treeSummary(doc, nodeId: string, depth = 3): string` — max depth 10; line per node `"<indent>frame \"Hero\" (id) 1440×900"`, unmeasured sizes as `?`, beyond depth `"… N children"`
  - `findNodes(doc, q: { filters?: { styleName?: string; styleValue?: string }[]; textValue?: string; nodeId?: string; pageId?: string }): { id: string; name: string; component: string; matched: ({ styleName: string; styleValue: string } | { textValue: string })[] }[]` — `*` wildcards; text match case-insensitive, anchored; colors compared by equivalence (normalize hex/rgb to rgba) and a literal color also matches a token whose value resolves to it (needs Task 5; add that one test in Task 5)

- [ ] **Step 1: Write failing tests:**
  - `inline jsx includes ids by default` and `includeNodeIds false strips them`
  - `root position stripped unless includeRootPositioning`
  - `tailwind maps flex column gap and keeps unmapped inline` → exact string `className="flex flex-col gap-[24px] bg-[#0F3B4C]"` and `style={{ mixBlendMode: "multiply" }}`
  - `round-trips non-latin text` → write `<p>Здравей 你好 👋</p>`, `toJsx` contains `Здравей 你好 👋`
  - `treeSummary respects depth and shows child counts`
  - `findNodes text wildcard` → `"Get *"` matches `"Get started"`, not `"Forget it"`
  - `findNodes color equivalence` → `#ccc` matches `rgb(204, 204, 204)`
- [ ] **Step 2–4:** run FAIL, implement, run PASS.
- [ ] **Step 5: Commit** `feat(doc): jsx export, tree summary, find nodes`.

---

### Task 5: Tokens

**Files:**
- Create: `packages/doc/src/tokens.ts`; Modify: `query.ts` (token-aware color match)
- Test: `packages/doc/test/tokens.test.ts`

**Interfaces:**
- Produces:
  - `type TokenType = 'breakpoint' | 'color' | 'container' | 'fontFamily' | 'fontSize' | 'fontWeight' | 'letterSpacing' | 'lineHeight' | 'opacity' | 'radius' | 'spacing'`
  - `interface Token { name: string; type: TokenType; value: string | number; description?: string }` stored in `ydoc.getArray('tokens')` (order matters)
  - `MarkupDoc.createTokens(actor, tokens: Token[]): { name: string; result: 'created' | 'error'; message?: string }[]` — name must match `^--[a-zA-Z0-9_-]+$`, description ≤ 1024
  - `MarkupDoc.setTokens(actor, edits: { name: string; newName?: string; value?: string | number; description?: string; delete?: boolean }[]): { name: string; result: 'updated' | 'deleted' | 'error'; message?: string }[]` — rename rewrites `var(--old)` references in node styles and other token values
  - `MarkupDoc.getTokens(opts?: { types?: TokenType[]; namePattern?: string; format?: 'json' | 'css' | 'tailwind' }): Token[] | string` — css → `:root {\n  --x: v;\n}`; tailwind → `@theme {\n  --color-x: v;\n}` (Tailwind v4 namespaces by type: color→`--color-`, spacing→`--spacing-`, radius→`--radius-`, fontSize→`--text-`, fontWeight→`--font-weight-`, fontFamily→`--font-`, lineHeight→`--leading-`, letterSpacing→`--tracking-`, breakpoint→`--breakpoint-`, container→`--container-`, opacity→`--opacity-`; strip a duplicate prefix)
  - `resolveTokenValue(doc, value: string): string` — follows `var()` aliases, max 16 hops

- [ ] **Step 1: Failing tests:** `invalid name returns error entry, others still created`; `alias resolves through two hops`; `rename rewrites var references in styles`; `delete removes token`; `css format`; `tailwind format namespaces color as --color-`; `findNodes literal color finds token-bound usage reported as var(--x)`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(doc): design tokens`.

---

### Task 6: History — action log and per-actor undo

**Files:**
- Create: `packages/doc/src/history.ts`
- Test: `packages/doc/test/history.test.ts`

**Interfaces:**
- Consumes: actor origins from Task 2.
- Produces:
  - `interface LogEntry { seq: number; at: number; actor: Actor; summary: string; reverted: boolean; revertedBy?: string }` stored in `ydoc.getArray('log')`; `seq` starts at 1
  - `MarkupDoc.log(): LogEntry[]` newest last
  - ops accept an optional summary: every public mutating method in Tasks 2–5 gets a trailing `summary?: string`; default summaries: `"Inserted 3 nodes"`, `"Updated styles on 2 nodes"`, `"Moved 1 node"`, `"Deleted 2 nodes"`, `"Duplicated 1 node"`, `"Renamed 1 node"`, `"Set text on 1 node"`, `"Created 2 tokens"`
  - `class ActorUndo { constructor(doc: MarkupDoc, actor: Actor); undo(): boolean; redo(): boolean; canUndo(): boolean; canRedo(): boolean; destroy(): void }` — wraps `Y.UndoManager` over nodes/pages/tokens with `trackedOrigins: new Set([actor])`, `captureTimeout: 0` (one op = one step)
  - `MarkupDoc.revertEntry(actor, seq: number): void` — undoes exactly that entry's changes (keep a per-entry `Y.UndoManager` stack item map), marks it `reverted: true, revertedBy: actor.id`; the entry stays in the log (never deleted); reverting an already reverted entry throws `INVALID_ARGUMENT`
  - log writes themselves are not tracked by any undo manager

- [ ] **Step 1: Failing tests:**
  - `each op appends one entry with actor and summary`
  - `undo reverts only own actor` → human sets width 100, agent sets fill red, human undo → width gone, fill still red
  - `redo restores`
  - `revertEntry keeps entry and marks reverted` → log length unchanged, `reverted === true`
  - `revert twice throws`
  - `log survives sync to a second doc`
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(doc): action log and per-actor undo`.

---

### Task 7: Protocol and doc-tool dispatcher

**Files:**
- Create: `packages/protocol/{package.json,tsconfig.json}`, `packages/protocol/src/{bridge.ts,tools.ts,index.ts}`, `packages/doc/src/tools.ts`
- Test: `packages/protocol/test/tools.test.ts`, `packages/doc/test/tools.test.ts`

**Interfaces:**
- Produces in `@markup/protocol`:
  - `const BRIDGE_PORT = 29980`; `const REQUEST_TIMEOUT_MS = 30_000`
  - `interface FileInfo { fileId: string; name: string; active: boolean }`
  - `type BridgeMessage = { type: 'hello'; role: 'editor' | 'agent'; clientId: string; app: 'markup'; files?: FileInfo[] } | { type: 'files'; files: FileInfo[] } | { type: 'request'; id: string; fileId?: string; method: ToolName; params: unknown; agent: { clientId: string; name: string } } | { type: 'response'; id: string; ok: true; result: unknown } | { type: 'response'; id: string; ok: false; error: { code: BridgeErrorCode; message: string } }`
  - `type BridgeErrorCode = 'NO_EDITOR' | 'FILE_NOT_OPEN' | 'EDITOR_DISCONNECTED' | 'TIMEOUT' | 'INVALID_PARAMS' | ErrorCode`
  - `const tools: Record<ToolName, { description: string; input: z.ZodObject<any> }>` for the phase-1 set: `get_guide, get_basic_info, get_selection, get_tree_summary, get_children, get_node_info, get_jsx, get_computed_styles, get_screenshot, find_nodes, create_artboard, write_html, update_styles, set_text_content, duplicate_nodes, move_nodes, delete_nodes, rename_nodes, finish_working_on_nodes, get_tokens, create_tokens, set_tokens, create_page`; descriptions adapted from feature list sections 18–19 with Markup names; `fileId` optional on every file-scoped tool, `pageId` where Paper has it
  - `type ToolName = keyof typeof tools`; `const DOM_TOOLS = ['get_selection', 'get_computed_styles', 'get_screenshot'] as const`
- Produces in `@markup/doc`:
  - `runDocTool(doc: MarkupDoc, actor: Actor, method: Exclude<ToolName, typeof DOM_TOOLS[number] | 'get_guide'>, params: unknown, ctx: { activePageId: string }): unknown` — validates with the zod schema (`INVALID_PARAMS` with zod's message), maps to doc methods; `get_basic_info` returns `{ fileId, fileName, page: {id, name}, pages: {type, id, name?, icon?, isActive}[], nodeCount, artboards: {id, name, width, height, worldX, worldY}[], fonts: string[], tokens: {name, type, value}[] }`; `create_artboard` places at `left = max(right edge of artboards) + 80`, `top = 0` (first artboard at 0,0); `get_guide` lives in the MCP server (static text)

- [ ] **Step 1: Failing tests:** protocol: `every tool has description and object schema`, `write_html requires html, targetNodeId, mode`. doc: `create_artboard places 80px right of last`, `write_html then get_jsx round trip`, `invalid params returns INVALID_PARAMS`, `get_basic_info lists artboards and tokens`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(protocol): bridge messages, tool schemas, doc tool dispatcher`.

---

### Task 8: `markup mcp` — hub and MCP server

**Files:**
- Create: `packages/mcp/{package.json,tsconfig.json}` (bin `markup` → `dist/cli.js`), `packages/mcp/src/{cli.ts,hub.ts,server.ts,guide.ts}`
- Test: `packages/mcp/test/hub.test.ts`, `packages/mcp/test/server.test.ts`

**Interfaces:**
- Consumes: `@markup/protocol`.
- Produces:
  - `startHub(port = BRIDGE_PORT): Promise<Hub>`; `interface Hub { request(msg: Omit<RequestMsg, 'type' | 'id'>): Promise<unknown>; close(): Promise<void> }` — binds `127.0.0.1`; routes a request to the editor whose `files` contain `fileId`, else to the editor with an `active` file; no editor → `NO_EDITOR` ("Markup isn't running with a file open. Open Markup, open a file, then retry."); editor socket closes with pending requests → `EDITOR_DISCONNECTED`; 30 s → `TIMEOUT`
  - `connectOrHost(port): Promise<Hub>` — try `startHub`; on `EADDRINUSE` connect as `role: 'agent'` and verify the peer's hello has `app: 'markup'` within 2 s; otherwise throw `Port 29980 is in use by another program. Free it, then restart your agent.`
  - `createServer(hub: Hub, agentName: string): McpServer` — registers every `tools` entry with its zod shape; `get_guide` answers from `guide.ts` (topics `markup-mcp-instructions`, `mobile-status-bar`); results returned as `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`, `get_screenshot` as `{ type: 'image', data, mimeType: 'image/png' }`; bridge errors → `isError: true` with the message
  - CLI: `markup mcp` → `connectOrHost` + `StdioServerTransport`; agent name from MCP `clientInfo.name`

- [ ] **Step 1: Failing tests** (fake editor = `ws` client sending hello with one active file and echoing requests):
  - `routes request to editor with active file`
  - `routes by fileId when two editors are connected`
  - `no editor gives NO_EDITOR`
  - `editor disconnect mid-request gives EDITOR_DISCONNECTED`
  - `timeout gives TIMEOUT` (inject `timeoutMs` 50 for the test)
  - `second process relays through first hub` → two `connectOrHost` calls, both reach the editor
  - `foreign port owner` → plain `net` server on the port that never speaks → rejects with the port message
  - server: `lists all phase-1 tools` via `InMemoryTransport` + MCP `Client.listTools()`; `tool error surfaces as isError`
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(mcp): markup mcp stdio server and localhost hub`.

---

### Task 9: Editor app — store, persistence, canvas rendering

**Files:**
- Create: `apps/app/{package.json,index.html,vite.config.ts,tsconfig.json}`, `src/main.tsx`, `src/App.tsx`, `src/store/{DocProvider.tsx,hooks.ts,persistence.ts}`, `src/canvas/{Canvas.tsx,NodeView.tsx,viewport.ts}`
- Test: `apps/app/test/viewport.test.ts`, `apps/app/test/NodeView.test.tsx` (vitest + jsdom + @testing-library/react)

**Interfaces:**
- Consumes: `MarkupDoc`, `Actor`.
- Produces:
  - `DocProvider({ doc, actor, children })`, `useDoc(): { doc: MarkupDoc; actor: Actor; undo: ActorUndo }`
  - `useNode(id): MarkupNode | undefined`, `useChildren(id): string[]`, `usePages(): PageEntry[]` — subscribe with `observeDeep` on the node's Y.Map, re-render only that node
  - `openLocalDoc(fileId?: string): Promise<MarkupDoc>` — `y-indexeddb` provider named `markup:<fileId>`; when no fileId, the last opened file from `localStorage['markup:last']` or a new doc
  - `interface Viewport { x: number; y: number; zoom: number }`; `screenToWorld(v, p)`, `worldToScreen(v, p)`, `zoomAt(v, screenPoint, factor): Viewport` (zoom clamped 0.02–256)
  - `Canvas` renders the active page root's artboards as absolutely positioned DOM at world coords inside one `transform: translate() scale()` layer; wheel = pan, ctrl/⌘+wheel = zoom at cursor, Space/H drag = pan
  - `NodeView({ id })` renders a node as real DOM: frame → `div`, text → `p` with `dangerouslySetInnerHTML` (sanitized: allow only inline formatting tags and `style`), image → `img`, svg → sanitized inline SVG; `data-node-id` on each element; hidden nodes `display:none`

- [ ] **Step 1: Failing tests:** `zoomAt keeps the world point under the cursor fixed`; `zoom clamps`; `NodeView renders frame styles` → element has `style.gap === '24px'`; `text html is sanitized` → `<script>` stripped, `<b>` kept; `useNode re-renders on style change`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Verify manually:** `pnpm --filter app dev`, open the URL, create an artboard via devtools `window.__markup.doc.writeHtml(...)` (expose in dev only), see it render; reload, it persists.
- [ ] **Step 6: Commit** `feat(app): document store, persistence, canvas rendering`.

---

### Task 10: Editor interactions and layers panel

**Files:**
- Create: `src/canvas/{SelectionOverlay.tsx,interactions.ts,tools.ts}`, `src/panels/LayersPanel.tsx`, `src/keyboard.ts`
- Test: `apps/app/test/interactions.test.ts`, `apps/app/test/keyboard.test.ts`

**Interfaces:**
- Consumes: Task 9 hooks, `MarkupDoc` ops, `ActorUndo`.
- Produces:
  - selection state `useSelection(): { ids: string[]; set(ids: string[]): void }` (local only, also exposed to the bridge as `getSelection()`)
  - `hitTest(doc, worldPoint, opts: { deep: boolean }): string | null` — top-most visible, unlocked node; non-deep returns the direct child of the artboard (Paper's shallow selection), deep (⌘-click) the leaf
  - drag move: absolute-positioned nodes and artboards update `left/top`; flex children reorder within the parent (move to sibling index by pointer position); resize handles update `width/height` in px; each gesture = one op (styles committed on pointerup, live preview via local state)
  - tools: `V` move, `F` frame (drag to draw an absolute frame/artboard), `R` rect, `T` text (click to create text node "Text", enter edit mode), `H` hand
  - keys: `Delete/Backspace` delete, `⌘D` duplicate, `Enter` select children, `Esc` select parent, `⌘Z / ⇧⌘Z` own undo/redo, `⌘R` rename, `⇧⌘H` hide, `⇧⌘L` lock, `⇧1` zoom to fit, `⌘0` 100%, `⇧F` wrap in frame, `⇧A` wrap in flex
  - `LayersPanel`: pages list + tree of the active page, click selects, double-click renames, drag reorders via `moveNodes`, eye/lock toggles, `⌥L` collapses all
- [ ] **Step 1: Failing tests:** `hitTest shallow returns artboard child`, `hitTest deep returns leaf`, `hitTest skips locked and hidden`, `keymap maps ⇧A to wrap-in-flex`, `undo key calls ActorUndo.undo`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Verify manually:** draw a frame, add text, move, resize, undo, reorder in layers.
- [ ] **Step 6: Commit** `feat(app): selection, tools, keyboard, layers panel`.

---

### Task 11: Inspector

**Files:**
- Create: `src/panels/Inspector.tsx`, `src/panels/fields/{NumberField.tsx,ColorField.tsx,SelectField.tsx}`, `src/panels/sections/{LayoutSection.tsx,SizeSection.tsx,FillSection.tsx,TextSection.tsx,RadiusSection.tsx,OtherStyles.tsx}`
- Test: `apps/app/test/Inspector.test.tsx`

**Interfaces:**
- Consumes: `useSelection`, `useNode`, `MarkupDoc.updateStyles`.
- Produces: sections editing the selection (mixed values show "Mixed"): Layout (display flex/none-flex, direction, gap, padding 4-side, align/justify, wrap), Size (width/height as Fixed px / Fill (`flex:1` or `100%` by parent axis) / Fit (`fit-content`)), Fill (backgroundColor hex or any CSS color, opacity), Text (fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textAlign, color), Radius (all or per corner), Other styles (every style key no section owns, editable as key/value — Paper's "Other styles")
- [ ] **Step 1: Failing tests:** `editing gap writes one updateStyles op`, `mixed selection shows Mixed`, `unknown style appears in Other styles`, `Fill sizing sets flex 1 in a row parent`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(app): inspector`.

---

### Task 12: Editor bridge client, DOM tools, agent log

**Files:**
- Create: `src/bridge/{client.ts,domTools.ts}`, `src/panels/AgentLog.tsx`, `src/canvas/WorkingIndicator.tsx`
- Test: `apps/app/test/bridge.test.ts`, `packages/mcp/test/e2e.test.ts`

**Interfaces:**
- Consumes: `@markup/protocol` messages, `runDocTool`, `ActorUndo`, `MarkupDoc.log/revertEntry`, `setWorking`.
- Produces:
  - `connectBridge(opts: { doc: MarkupDoc; getSelection(): string[]; activePageId(): string; url?: string }): { close(): void; status: 'connecting' | 'connected' | 'offline' }` — reconnects every 2 s while offline, sends `hello` + `files`; per agent `clientId` creates `Actor { id: 'agent:' + clientId, kind: 'agent', name }` and runs doc tools with it
  - DOM tools: `get_selection` → `{ nodes: {id, name, component, width, height, artboardId}[] }`; `get_computed_styles` → `getComputedStyle` of `[data-node-id]` elements, only properties that differ from the element's defaults; `get_screenshot` → `html-to-image` `toPng` of the node at `scale` 1 or 2, longest side capped at 2048 px, base64 without the data-URL prefix
  - writes by an agent call `setWorking(actor, [artboard], true)`; `WorkingIndicator` shows "<agent name> is editing" on that artboard's label until `finish_working_on_nodes`
  - `AgentLog` panel: `doc.log()` newest first, each row `No. 047 · 14:32 · <actor> · <summary>`, a Revert button on unreverted rows, reverted rows struck through and labelled "Reverted"
- [ ] **Step 1: Failing tests:** bridge: `runs write_html as agent actor` (fake hub), `reconnects after hub restart`. e2e: start hub, connect a headless editor (`connectBridge` with a `MarkupDoc`, DOM tools stubbed), MCP `Client` calls `create_artboard` → `write_html` → `get_jsx` and sees the HTML; `doc.log()` attributes entries to the agent.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Verify manually:** run the editor, register `markup mcp` in Claude Code (`claude mcp add markup -- node <repo>/packages/mcp/dist/cli.js mcp`), ask it to draw a 1440×900 artboard with a hero; watch it appear, see the working indicator and log entries, revert one entry.
- [ ] **Step 6: Commit** `feat(app): bridge client, dom tools, agent log`.

---

### Task 13: Tauri 2 desktop shell

**Files:**
- Create: `apps/app/src-tauri/` via `pnpm --filter app exec tauri init` (app name `Markup`, identifier `org.markup.app`, dev URL `http://localhost:5173`, frontend dist `../dist`), icons from `assets/icon.svg` (`pnpm tauri icon`)
- Modify: `apps/app/package.json` scripts `desktop:dev`, `desktop:build`

**Interfaces:**
- Consumes: the web app as-is; the bridge client connects to `ws://127.0.0.1:29980` from the webview (add it to the Tauri CSP `connect-src`).
- [ ] **Step 1: Run** `pnpm --filter app desktop:dev` — window opens with the editor, persistence works across restarts.
- [ ] **Step 2: Run** the Task 12 manual MCP check against the desktop window — agent edits land.
- [ ] **Step 3: Run** `pnpm --filter app desktop:build` — installer produced under `src-tauri/target/release/bundle`.
- [ ] **Step 4: Commit** `feat(desktop): tauri 2 shell`.

---

## Out of scope for this plan (next plans)

Comments and resources tools, export/PDF/video, fonts tool, page arrange tools, Supabase accounts and Hocuspocus multiplayer, the Chrome extension, shaders, vectors/pen tool, image generation, `markup://` deep links, the visual identity.
