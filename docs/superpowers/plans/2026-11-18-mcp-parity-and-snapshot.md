# MCP Parity and Snapshot Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `markup mcp` exposes all 41 Paper-compatible tools, the editor gains the features those tools need (multiple files, comments, export, fonts, paste), the `markup` command installs into agents in one click, and a Chrome extension snapshots any live page element into Markup as editable layers.

**Architecture:** New document data lives in `@markup/doc` (pages arrangement, comments, export settings) and a new `MarkupLibrary` (files and folders, its own Y.Doc). The editor becomes a workspace that keeps several open files and routes each bridge request by `fileId`. Exports are rendered in the editor and written to disk by the `markup mcp` process, which returns file paths like Paper. The extension (`apps/extension`, Chrome MV3) serializes a picked element into Markup's HTML dialect and puts it on the clipboard; the editor's paste handler turns it into layers. No direct extension-to-app channel: clipboard, as in Paper.

**Tech Stack:** existing stack plus jsPDF (PDF), @jsquash/avif (AVIF, lazy), Chrome MV3 + esbuild (extension), bun `--compile` (single-file `markup` binary), Tauri shell plugin (sidecar).

**Spec:** `PRODUCT.md`, the feature list artifact https://claude.ai/artifact/SNqrCKg8QidtJfggPxJWPy (sections 10, 11, 13, 14, 18, 19, 20), and the user's request of 2026-11-18: full MCP, and the browser extension must work with the app as it does in Paper. Builds on `docs/superpowers/plans/2026-11-18-markup-foundation.md` (merged).

## Global Constraints

- Everything from the foundation plan's Global Constraints still holds (TS strict, ESM, actor-attributed transactions, hub on 127.0.0.1:29980 with the Origin allowlist, neutral UI).
- Tool names, parameters and result shapes follow Paper's schemas (feature list section 18; the foundation plan's `packages/protocol/src/tools.ts` already mirrors the 23 done).
- After this plan `PHASE1_TOOLS` is renamed `ALL_TOOLS` and has exactly 41 entries. Each task that adds tools also bumps the count asserted in `packages/protocol/test/tools.test.ts` (23 → 25 → 33 → 37 → 38 → 41); Task 12 does the rename.
- Video export (`mp4`, `webm`) is accepted by the schema and answered with error code `UNSUPPORTED` and message "Video export is not available yet." - no fake output.
- All local files report `draft: true` (no teams until the Supabase plan).
- Export files are written by the MCP process to `MARKUP_EXPORT_DIR` or, by default, `<home>/Downloads/Markup`; names `<layer name>@<scale>.<ext>`, made unique with ` (2)`, ` (3)`.
- Extension: Chrome MV3, permissions `activeTab`, `scripting`, `clipboardWrite`, host permission `<all_urls>` (image inlining needs it), no remote code, no analytics.
- Snapshot activation: toolbar icon or `Ctrl+Shift+P` / `Command+Shift+P` (`commands` API, user-rebindable at `chrome://extensions/shortcuts`); `↑`/`↓` move the target to parent/child; `Enter` or click captures; `⌘/Ctrl+Enter` captures the whole page; `Shift+click` adds to a multi-capture; `Esc` exits.
- Snapshot output must be valid Markup dialect: running `parseHtml` on it reports `ignored: []`.
- Clipboard payload marker: the HTML starts with `<!--markup:snapshot v1-->`.

## Review Focus

1. **Snapshot of real-world CSS** - grid layouts, margins, inline elements, `::before`/`::after` content, transforms, sticky headers: the paste must look like the page (absolute fallback), never an empty or collapsed frame (Task 11 tests `grid container falls back to absolute children`, `margins become positions`, `pseudo-element content is captured`).
2. **Cross-origin and broken images** during capture - CORS-blocked, 404, huge (> 8 MB), `srcset`, CSS `background-image: url()`: each becomes a data URL or a neutral placeholder frame, capture never throws (Task 11 test `failed image fetch becomes a placeholder`).
3. **Bridge request for a file that is closed or archived** - `FILE_NOT_OPEN` with a sentence pointing to `open_file`, never routed to the wrong file (Task 3 test `routes by fileId across tabs`).
4. **Export of a node on a page the user is not viewing** - the editor renders it off-screen and exports it; the agent never gets `NODE_NOT_FOUND` for a hidden page (Task 7 test `exports a node from an inactive page`).
5. **Paste of arbitrary HTML from other apps** (Word, Google Docs, websites without the extension) - imports as layers inside the selection or a new artboard, scripts and event handlers stripped (Task 9 tests `pastes foreign html without scripts`, `pastes into the selected frame`).

---

## File Structure

```
packages/doc/src/
  pages.ts          updatePages, arrangePages (dividers)
  comments.ts       comment threads model + queries
  exports.ts        per-node export settings, parseScale(), export file naming
  library.ts        MarkupLibrary: files/folders Y.Doc
packages/protocol/src/tools.ts        +18 tool schemas, ALL_TOOLS
packages/mcp/src/
  exportsink.ts     writes export payloads to disk, returns paths
  install.ts        `markup install <agent>` config writers
  cli.ts            subcommands: mcp, install
apps/app/src/
  workspace/        Workspace (open docs, tabs), Dashboard, FileTabs, persistence per file
  bridge/resourceTools.ts   resource tools against the library/workspace
  bridge/exportTools.ts     export, export_combined_pdf, get_fill_image
  bridge/fontTools.ts       get_font_family_info
  export/           render.ts (raster/svg/pdf), ExportSection.tsx, clipboard.ts
  fonts/            google-fonts.json (generated), fontLoader.ts, localFonts.ts
  comments/         CommentLayer.tsx, ThreadPopover.tsx, CommentsPanel.tsx
  paste.ts          clipboard paste → layers
  panels/McpPanel.tsx       one-click agent install (desktop) + copyable commands (web)
apps/extension/
  manifest.json, build.mjs
  src/background.ts         toggle, command, image fetch proxy
  src/picker/               overlay.ts, picker.ts (hover, keys, multi)
  src/capture/              serialize.ts, styles.ts, images.ts, env.ts
  test/
scripts/gen-google-fonts.mjs
```

---

### Task 1: Page tools - update_pages and arrange_pages

**Files:** Create `packages/doc/src/pages.ts`; Modify `document.ts`, `tools.ts` (doc), `packages/protocol/src/tools.ts`; Test `packages/doc/test/pages.test.ts`

**Interfaces:**
- Produces:
  - `MarkupDoc.updatePages(actor, updates: { pageId: string; name?: string; icon?: PageIcon | null }[]): void` - `null` icon restores default
  - `MarkupDoc.arrangePages(actor, order: (string | { type: 'divider' })[], removeDividerIds?: string[]): PageEntry[]` - rejects with `INVALID_ORDER` (no change) when order misses an item, repeats one, or names an unknown id; never deletes pages; new dividers get ids. Reordering rebuilds `pagesArr` entries as fresh Y.Maps with the same fields (Yjs cannot move a shared type).
  - protocol: `update_pages`, `arrange_pages` schemas (Paper's descriptions, feature list section 18)
- [ ] **Step 1: Failing tests:** `renames and sets icon`; `null icon restores default`; `arrange reorders and adds a divider`; `missing page in order is INVALID_ORDER and changes nothing`; `removeDividerIds drops dividers`; `page root ids survive arrange`; `runDocTool update_pages / arrange_pages`.
- [ ] **Step 2–4:** run FAIL (`pnpm vitest run --project doc`), implement, run PASS.
- [ ] **Step 5: Commit** `feat(doc): update and arrange pages`.

---

### Task 2: File library model

**Files:** Create `packages/doc/src/library.ts`; Test `packages/doc/test/library.test.ts`

**Interfaces:**
- Produces:
  - `interface LibraryItem { id: string; type: 'file' | 'folder'; name: string; parentId: string | null; archived: boolean; createdAt: number; updatedAt: number; thumbnail?: string }`
  - `class MarkupLibrary { constructor(ydoc?: Y.Doc); readonly ydoc: Y.Doc; list(opts?: { parentId?: string; includeArchived?: boolean; limit?: number }): { items: LibraryItem[]; truncated?: true }; get(id): LibraryItem | undefined; addFile(opts: { id: string; name: string; parentId?: string | null }): LibraryItem; createFolder(opts: { name?: string; parentId?: string | null }): LibraryItem; rename(id, name): LibraryItem; move(ids: string[], parentId: string): { moved: LibraryItem[]; alreadyThere: LibraryItem[] }; archive(ids: string[]): LibraryItem[]; unarchive(ids: string[]): (LibraryItem & { parentId: string | null })[]; touch(id, patch?: { thumbnail?: string }): void }`
  - rules (Paper's, feature list section 18): names trimmed, capped at 500, empty rename keeps the old name; folder default name `"Untitled project"`; `list` sorted by `updatedAt` desc, default limit 50, max 200; archiving a folder archives its subtree; every id checked first - any invalid id → `INVALID_ARGUMENT`, nothing changes; moving a folder into itself or its descendant → `CYCLE`; passing a folder and an item inside it to `move` → `INVALID_ARGUMENT`; unarchiving an item whose folder stays archived moves it to top level
- [ ] **Step 1: Failing tests:** one per rule above, plus `persists through a Y update to a second library`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(doc): file library model`.

---

### Task 3: Workspace - dashboard, tabs, multi-file bridge, resource tools

**Files:**
- Create: `apps/app/src/workspace/{Workspace.ts,WorkspaceProvider.tsx,Dashboard.tsx,FileTabs.tsx,persistence.ts}`, `apps/app/src/bridge/resourceTools.ts`
- Modify: `App.tsx` (workspace instead of one doc), `Editor.tsx` (takes the active doc), `bridge/client.ts` (many docs), `packages/protocol/src/tools.ts` (8 resource tools), `store/persistence.ts` (moved into workspace/persistence.ts)
- Test: `apps/app/test/workspace.test.ts`, `apps/app/test/resourceTools.test.ts`, extend `apps/app/test/bridge.test.ts`

**Interfaces:**
- Consumes: `MarkupLibrary` (Task 2), `MarkupDoc`, `openLocalDoc` logic.
- Produces:
  - `class Workspace { constructor(opts: { library: MarkupLibrary; openDoc(fileId: string): Promise<MarkupDoc>; createDoc(name: string, cloneOf?: MarkupDoc): Promise<MarkupDoc> }); tabs(): { fileId: string; name: string; active: boolean }[]; open(fileId: string, pageId?: string): Promise<MarkupDoc>; close(fileId): void; activate(fileId): void; doc(fileId): MarkupDoc | undefined; activeDoc(): MarkupDoc | undefined; createFile(opts: { name?: string; parentId?: string; cloneFileId?: string }): Promise<LibraryItem & { url: string }>; on(event: 'change', fn): () => void }` - file URL `markup://file/<id>` (deep link registration is out of scope)
  - library persistence: y-indexeddb `markup:library`; existing single file from the foundation (`markup:last`) is imported into the library on first run
  - library `updatedAt` touched (debounced 2 s) on doc updates; thumbnail = 320px-wide PNG of the first artboard, taken when a tab closes
  - `connectBridge` change: `opts.workspace` replaces `opts.doc`; `files` = `workspace.tabs()` (sent again on every tab change); a request is routed to `workspace.doc(msg.fileId ?? active)`; resource tools run against the workspace whatever the file
  - resource tools (Paper semantics, feature list section 18): `list_resources` (open tabs first with `open`/`active`, then library items by `updatedAt`, `draft: true`), `open_file` (accepts id, `/file/<id>`, or `markup://file/<id>`; `pageId` applied only when not already open), `create_file`, `create_folder`, `rename_resource`, `move_resources`, `archive_resources`, `unarchive_resources`
  - UI: `Dashboard` (folders tree left, files grid with thumbnails, search across all folders, new file/folder, rename, move via context menu, archive/unarchive, Archive view), `FileTabs` top strip with close buttons; `⌘\` toggles dashboard
- [ ] **Step 1: Failing tests:** workspace: `open twice reuses the doc`, `close keeps others`, `createFile with cloneFileId copies pages and nodes`, `first run imports the foundation file`. resources: one per tool incl. `open_file accepts markup:// url`, `list_resources lists open tabs first`. bridge: `routes by fileId across tabs`, `closed file gives FILE_NOT_OPEN mentioning open_file`, `files message follows tab changes`.
- [ ] **Step 2–4:** FAIL, implement, PASS (`pnpm vitest run --project app`).
- [ ] **Step 5: Commit** `feat(app): workspace with dashboard, tabs and resource tools`.

---

### Task 4: Comments model and MCP comment tools

**Files:** Create `packages/doc/src/comments.ts`; Modify `document.ts`, doc `tools.ts`, protocol `tools.ts`; Test `packages/doc/test/comments.test.ts`

**Interfaces:**
- Produces:
  - `interface CommentMessage { id: string; authorId: string; authorName: string; body: string; createdAt: number; attachments: { name: string; url: string; mimeType: string }[]; reactions: Record<string, string[]>; deleted?: true }`
  - `interface CommentThread { id: string; pageId: string; nodeId: string | null; x: number; y: number; status: 'open' | 'resolved'; createdAt: number; updatedAt: number; messages: CommentMessage[]; deleted?: true }` in `ydoc.getArray('comments')`; `x/y` are offsets inside `nodeId` (or world coords when null)
  - `MarkupDoc.createThread(actor, { pageId, nodeId, x, y, body }): string`, `reply(actor, threadId, body): string`, `setThreadStatus(actor, threadId, status)`, `deleteMessage(actor, threadId, messageId)`, `react(actor, threadId, messageId, emoji)`, `threads(): CommentThread[]` (deleted excluded)
  - `queryThreads(doc, q: { status?: 'open' | 'resolved' | 'all'; pageId?; nodeId?; currentPageOnly?; activePageId; participantUserId?; threadAuthorUserId?; currentUserId: string; search?; searchScope?: 'first-message' | 'all-messages'; sortField?: 'page' | 'createdAt' | 'updatedAt'; sortDirection?: 'asc' | 'desc'; limit?: number; offset?: number; previewLength?: number }): { threads: { id, status, pageId, nodeId, authorName, preview, replyCount, createdAt, updatedAt }[]; total: number }` - defaults from Paper: status open, limit 50 (max 200), preview 240, sort by page asc; `"current-user"` resolves to `currentUserId`
  - `threadAuthors(doc, pageId?): { userId, displayName, threadsStarted, messagesWritten, lastActivityAt }[]`
  - tools `list_comment_threads`, `get_comment_thread`, `list_comment_thread_authors`, `set_comment_thread_status`; thread/message changes are actor-attributed and logged ("Resolved comment", "Replied to comment")
- [ ] **Step 1: Failing tests:** `create and reply`, `list defaults to open threads`, `search all messages vs first message`, `current-user filter`, `pagination`, `authors counts exclude deleted`, `resolve via tool logs the agent`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(doc): comment threads and comment tools`.

---

### Task 5: Comments UI

**Files:** Create `apps/app/src/comments/{CommentLayer.tsx,ThreadPopover.tsx,CommentsPanel.tsx}`; Modify `canvas/tools.ts` (tool `comment`, key `C`), `keyboard.ts`, `Editor.tsx`, `panels/RightPanel.tsx` (tab "Comments"); Test `apps/app/test/comments.test.tsx`

**Interfaces:**
- Consumes: Task 4 API.
- Produces: comment tool click → pin at the hit node (offset) or world point → popover with composer (Enter sends, Shift+Enter newline); pins rendered in screen space, numbered, resolved hidden unless the panel filter shows them; popover: messages, reply box, Resolve/Reopen, delete own message; Comments panel: search, filter (open / resolved / all, current page), sort (page, newest, last activity), unread dot (last-seen per thread in localStorage)
- [ ] **Step 1: Failing tests:** `C selects the comment tool`, `posting creates a thread at the node`, `resolve hides the pin`, `panel search filters threads`, `unread dot clears when opened`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(app): comments`.

---

### Task 6: Fonts - get_font_family_info and font loading

**Files:** Create `scripts/gen-google-fonts.mjs`, `apps/app/src/fonts/{google-fonts.json,fontLoader.ts,localFonts.ts}`, `apps/app/src/bridge/fontTools.ts`; Modify protocol `tools.ts`, `canvas/Canvas.tsx` (load used fonts); Test `apps/app/test/fonts.test.ts`

**Interfaces:**
- Produces:
  - `scripts/gen-google-fonts.mjs` downloads `https://fonts.google.com/metadata/fonts` once (run by hand, output committed): `{ family: string; styles: { weight: number; italic: boolean }[]; axes: { tag: string; min: number; max: number }[] }[]`
  - `familyInfo(names: string[], local: LocalFont[]): { family: string; available: boolean; source: 'local' | 'google' | null; styleGroups: { italic: boolean; width: string; weights: number[]; axes: { tag: string; min: number; max: number }[] }[] }[]` - local wins over Google (feature list section 5)
  - `listLocalFonts(): Promise<LocalFont[]>` via `queryLocalFonts()` when present, else `[]`
  - `ensureFontsLoaded(families: string[]): void` - one `<link>` to `https://fonts.googleapis.com/css2?family=...` per Google family used in the active page (all weights and axes), skipped for local families
  - tool `get_font_family_info`; `get_basic_info.fonts` unchanged
- [ ] **Step 1: Failing tests:** `google family reports weights and axes`, `local font wins over google`, `unknown family is unavailable`, `css2 url encodes axes ranges`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(app): font info and google font loading`.

---

### Task 7: Export engine and export tools

**Files:** Create `packages/doc/src/exports.ts`, `apps/app/src/export/render.ts`, `apps/app/src/bridge/exportTools.ts`, `packages/mcp/src/exportsink.ts`; Modify protocol `tools.ts`, `packages/mcp/src/server.ts`; Test `packages/doc/test/exports.test.ts`, `apps/app/test/exportTools.test.ts`, `packages/mcp/test/exportsink.test.ts`

**Interfaces:**
- Produces:
  - `type ExportFormat = 'avif' | 'jpg' | 'mp4' | 'pdf' | 'png' | 'svg' | 'webm' | 'webp'`; `interface ExportSetting { format: ExportFormat; scale: string; pdfQuality?: 'low' | 'medium' | 'high'; pdfResampling?: 'detailed' | 'basic'; durationSeconds?: number }`; default `{ format: 'png', scale: '2x' }`
  - `MarkupDoc.setExports(actor, nodeId, settings: ExportSetting[]): void`, `exportsOf(nodeId): ExportSetting[]` (node field `exports`, JSON)
  - `parseScale(scale: string, size: { width: number; height: number }): number` - `"2x"` → 2, `"720p"` → 720 / shortest side, `"512w"` → 512 / width, `"512h"` → 512 / height; invalid → `INVALID_PARAMS`
  - `renderExport(el: HTMLElement, setting: ExportSetting): Promise<{ bytes: Uint8Array; mimeType: string; ext: string }>` - png/jpg/webp via html-to-image canvas + `toBlob`; avif via lazily imported `@jsquash/avif` from the canvas ImageData; svg only for `svg` nodes (else `INVALID_ARGUMENT` "SVG export is only available for SVG layers."); pdf via jsPDF, page = node size in px, image quality low 0.6 / medium 0.8 / high 0.95, resampling detailed renders at 2x then downscales with `imageSmoothingQuality: 'high'`, basic at 1x; mp4/webm → `UNSUPPORTED`
  - off-page rendering: a node on a page that is not shown is mounted into a hidden off-screen host (`position: fixed; left: -100000px`) with the same `NodeView`, exported, then unmounted
  - editor tool results carry `{ files: { nodeId, name, format, scale, mimeType, data: base64 }[] }`; `exportsink.writeExports(result, dir = exportDir()): { nodeId, path, format }[]`; the MCP server turns `export` / `export_combined_pdf` results into the written paths before replying
  - `nodes: 'nodes-with-exports-only'` exports every node on the page with settings; an empty settings array means defaults
  - `export_combined_pdf`: one PDF, one page per node, ordered top-to-bottom then left-to-right, highest quality/resampling found among the nodes' settings
  - `get_fill_image`: image node `src` or `backgroundImage: url(...)` → JPEG base64, longest side ≤ 1568 px, plus `{ originalUrl }`; SVG node → message pointing to `get_jsx`; returned to the agent as an image content block
- [ ] **Step 1: Failing tests:** doc: `parseScale x p w h`, `invalid scale`, `export settings persist and are logged`. app: `png export at 2x has doubled size` (stub canvas), `svg export rejects frames`, `video gives UNSUPPORTED`, `exports a node from an inactive page`, `nodes-with-exports-only picks configured nodes`, `combined pdf orders by position`. mcp: `writes unique file names`, `honours MARKUP_EXPORT_DIR`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat: export engine and export tools`.

---

### Task 8: Export UI and copy actions

**Files:** Create `apps/app/src/export/{ExportSection.tsx,clipboard.ts}`; Modify `panels/Inspector.tsx`, `keyboard.ts`, `commands.ts`; Test `apps/app/test/exportUi.test.tsx`

**Interfaces:**
- Consumes: Task 7 `renderExport`, `setExports`, `toJsx`.
- Produces: Inspector "Export" section: list of settings (format select, scale input with presets 0.5x 1x 2x 3x 4x 512w 1080p), add/remove, Export button (browser: download; Tauri: save dialog via `@tauri-apps/plugin-dialog` + `plugin-fs`); commands `exportSelection` (⌘⇧E), `copyPng` (⌘⇧C), `copyReact` (⌥R, inline-style JSX of the selection, ids off), `copyTailwind` (⌥T); right-click "Copy as" menu entries for the same three
- [ ] **Step 1: Failing tests:** `adding a setting writes it to the node`, `⌥R copies jsx without ids`, `⌥T copies tailwind`, `⌘⇧E exports each selected node`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(app): export panel and copy as react, tailwind, png`.

---

### Task 9: Paste

**Files:** Create `apps/app/src/paste.ts`; Modify `Editor.tsx` (paste listener), `keyboard.ts` (`⇧⌘V` paste on top, `⇧⌘R` paste to replace via `navigator.clipboard.read()`); Test `apps/app/test/paste.test.ts`

**Interfaces:**
- Consumes: `MarkupDoc.writeHtml`, `insertNodes`.
- Produces: `pasteIntoDoc(doc, actor, data: { html?: string; text?: string; files?: File[] }, target: { selection: string[]; rootId: string; viewportCenter: Point }): Promise<string[]>`:
  - target: the single selected frame (as children), the parent of a selected non-frame, else a new artboard sized to the content at the viewport centre (snapshot payloads always get a new artboard named after the page title in the payload)
  - HTML: DOMPurify (no scripts, no `on*`, no `javascript:`), Office/Docs cruft stripped (`<o:p>`, `mso-*` styles, `<meta>`), then `writeHtml`
  - SVG text (`<svg` …) → svg node; image files (png/jpg/gif/webp/heic) → image node with a data URL (HEIC converted through `createImageBitmap` when the webview supports it, else rejected with a message); plain text → text node
  - paste on top: same as paste but at the original position over the selection; paste to replace: replaces each selected node, keeping its position and size
- [ ] **Step 1: Failing tests:** `pastes foreign html without scripts`, `pastes into the selected frame`, `snapshot payload makes a new artboard`, `svg text becomes svg node`, `image file becomes image node`, `plain text becomes text node`, `paste to replace keeps position`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(app): paste html, svg, images and text`.

---

### Task 10: Extension - scaffold and element picker

**Files:** Create `apps/extension/{package.json,manifest.json,build.mjs,tsconfig.json,vitest.config.ts}`, `src/background.ts`, `src/picker/{picker.ts,overlay.ts}`, `src/content.ts`, `icons/` (from `assets/icon.svg`); Test `apps/extension/test/picker.test.ts`

**Interfaces:**
- Produces:
  - manifest: MV3, name "Markup Snapshot", `action` (toggles), `commands.toggle-snapshot` with `suggested_key { default: "Ctrl+Shift+P", mac: "Command+Shift+P" }`, background service worker, permissions per Global Constraints
  - background: on action click or command → `chrome.scripting.executeScript` injects `content.js` once per tab and sends `{ type: 'toggle' }`; handles `{ type: 'fetch-image', url }` → `{ dataUrl } | { error }` (fetch with credentials omitted, 8 MB cap, 10 s timeout)
  - `class Picker { constructor(doc: Document, onCapture(targets: Element[] | 'page'): void); start(); stop(); readonly target: Element | null; readonly selected: Element[] }` - hover sets target to the element under the pointer (ignoring the overlay's own shadow root); `ArrowUp` → parent (stops at `body`), `ArrowDown` → back down the path it came from, else first element child; `Enter`/click → capture `selected` plus target; `Shift+click` toggles an element in `selected`; `Ctrl/⌘+Enter` → `'page'`; `Esc` → stop; keys are swallowed only while active
  - overlay in a closed shadow root: highlight box, label `tag.class · 320×48`, hint bar "↑↓ adjust · Enter capture · ⌘Enter page · Esc exit", toast "Copied - paste into Markup" after capture
- [ ] **Step 1: Failing tests** (jsdom): `ArrowUp moves to parent and ArrowDown returns`, `shift click builds a multi selection`, `Escape stops and removes the overlay`, `keys pass through when inactive`, `manifest declares the command and permissions` (reads manifest.json).
- [ ] **Step 2–4:** FAIL, implement, PASS (`pnpm vitest run --project extension`).
- [ ] **Step 5: Commit** `feat(extension): scaffold and element picker`.

---

### Task 11: Extension - capture to Markup HTML and clipboard

**Files:** Create `apps/extension/src/capture/{env.ts,serialize.ts,styles.ts,images.ts}`; Modify `content.ts`; Test `apps/extension/test/serialize.test.ts`, `apps/extension/test/dialect.test.ts`

**Interfaces:**
- Consumes: `parseHtml` from `@markup/doc` (dialect check in tests only).
- Produces:
  - `interface CaptureEnv { style(el: Element, pseudo?: '::before' | '::after'): CSSStyleDeclaration; rect(el: Element): DOMRect; fetchImage(url: string): Promise<string | null> }` - real env uses `getComputedStyle`, `getBoundingClientRect` (+ scroll offsets), background `fetch-image`; tests inject fakes
  - `capture(targets: Element[] | 'page', env: CaptureEnv, meta: { title: string; url: string }): Promise<string>` → `<!--markup:snapshot v1-->` + `<div layer-name="<title>" data-source="<url>" style="position:relative;width:Wpx;height:Hpx">…</div>`; several targets are laid side by side 80px apart
  - layout conversion (per element):
    - `display: none`, `visibility: hidden`, zero-size without visible overflow → skipped
    - flex container whose children have no margins and are not absolutely positioned → frame keeping `display:flex`, direction, wrap, `gap` (row/column), align/justify, padding; children recursively in flow
    - everything else (block, inline, grid, table, flex with margins) → frame `position:relative`, fixed `width`/`height` from the rect, children `position:absolute` at their rect offset from the parent's padding box
    - text: an element whose content is only text and inline formatting → one text node, fixed width (keeps wrapping), inner HTML with inline spans' computed `color`/`font-weight`/`font-style`/`text-decoration` inlined; bare text runs inside mixed content → text nodes positioned by `Range.getBoundingClientRect`
    - `::before`/`::after` with `content` other than `none`/`""` → child frame/text from the pseudo's computed style and rect
    - copied properties: background-color, background-image (gradients kept, `url()` inlined as data URL), border per side, border-radius per corner, box-shadow, opacity, overflow hidden, filter, backdrop-filter, mix-blend-mode, color, font-family (first family), font-size, font-weight, font-style, line-height, letter-spacing, text-align, text-transform, text-decoration, white-space, font-feature-settings, font-variation-settings, object-fit, `transform` rotate only
    - `img`/`picture` (current source) → `<img>` with data URL, object-fit; `svg` → outer HTML with `currentColor` and CSS fills resolved to computed values; `canvas` → `toDataURL()`; `video` → poster or current frame; `input`/`textarea`/`select`/`button` → frame with the box styles + text of value or placeholder; `iframe` → placeholder frame labelled with its src host
    - failed or oversized image → frame with the image box size, `backgroundColor: #e4e4e7`, `layer-name="Image unavailable"`
  - clipboard: `navigator.clipboard.write([new ClipboardItem({ 'text/html': blob(html), 'text/plain': blob(page title + url) })])` inside the capture gesture; fallback `document.execCommand('copy')` with a hidden contenteditable when `clipboard.write` is refused
- [ ] **Step 1: Failing tests:** `flex row keeps flex and gap`, `grid container falls back to absolute children`, `margins become positions`, `text keeps inline formatting`, `pseudo-element content is captured`, `hidden elements are skipped`, `failed image fetch becomes a placeholder`, `svg currentColor is resolved`, `input shows its placeholder`, `two targets sit 80px apart`, dialect: `every fixture parses with no ignored styles`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Verify manually** (user): load `apps/extension/dist` unpacked in Chrome, capture a card on any site, paste into Markup; capture a localhost dev page with images.
- [ ] **Step 6: Commit** `feat(extension): capture pages as markup layers`.

---

### Task 12: `markup` command, one-click agent install, tool parity check

**Files:** Create `packages/mcp/src/install.ts`, `apps/app/src/panels/McpPanel.tsx`; Modify `packages/mcp/src/cli.ts`, `packages/mcp/package.json` (script `compile`), `apps/app/src-tauri/tauri.conf.json` (`externalBin`), `apps/app/src-tauri/src/lib.rs` (shell plugin), `apps/app/src-tauri/capabilities/default.json`, `README.md`; Test `packages/mcp/test/install.test.ts`, `packages/protocol/test/tools.test.ts` (count)

**Interfaces:**
- Produces:
  - `markup install <claude-code|cursor|vscode|codex|opencode|print> [--command <path>]` - writes the stdio entry `{ command: <path to markup>, args: ['mcp'] }`: Claude Code by running `claude mcp add --scope user markup -- <path> mcp`; Cursor `~/.cursor/mcp.json` (`mcpServers.markup`); VS Code user `mcp.json` (`servers.markup`, `type: "stdio"`); Codex `~/.codex/config.toml` (`[mcp_servers.markup]`); OpenCode `~/.config/opencode/opencode.json` (`mcp.markup`, `type: "local"`, `enabled: true`); `print` prints all snippets; existing config is merged, never overwritten, and a `.bak` is written first
  - `pnpm --filter @markup/mcp compile` → `bun build src/cli.ts --compile --outfile dist/markup-<target-triple>` (Tauri sidecar naming)
  - desktop: sidecar bundled; McpPanel (menu "Connect an agent") lists agents with "Add to …" buttons running `markup install <agent>` via the shell plugin, shows the result, and the copyable commands; web build shows only the copyable commands
  - protocol: `ALL_TOOLS` has 41 names, equal to feature list section 18
- [ ] **Step 1: Failing tests:** `cursor config merged with existing servers`, `codex toml appended once`, `vscode uses servers key and stdio type`, `backup written before change`, `print shows every agent`, `ALL_TOOLS matches Paper's 41`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Run** `pnpm --filter @markup/mcp compile` and `pnpm --filter app desktop:build` - installer contains the sidecar.
- [ ] **Step 6: Commit** `feat: markup command, one-click agent install, full tool set`.

---

## Out of scope (later plans)

Video export, AI image generation (`markup-gen://`), remote MCP, Figma paste specifics, `markup://` OS deep-link registration, Supabase teams/multiplayer, the visual identity, publishing the extension to the Chrome Web Store.
