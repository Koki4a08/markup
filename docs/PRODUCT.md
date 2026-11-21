# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop shell wraps the same web editor (Tauri 2). The design language is one cross-platform web language, not native per OS.

## Stack

- Monorepo: pnpm workspaces, TypeScript everywhere.
- Editor (`apps/app`): Vite + React. Canvas renders real DOM (HTML/CSS), not a bitmap.
- Desktop: Tauri 2 (user choice over Electron, accepting that WebView2 / WebKit / WebKitGTK render CSS slightly differently per OS).
- Document model: Yjs CRDT. Local persistence in IndexedDB (web) and on disk (desktop).
- Cloud (phase 2): Supabase for auth, Postgres, storage; Hocuspocus for real-time Yjs sync.
- MCP (`packages/mcp`): `markup mcp` stdio CLI, talking to the running editor over a localhost WebSocket bridge.
- Extension (`apps/extension`): Chrome MV3 element snapshot tool.
- Shaders: `@paper-design/shaders` (Apache 2.0, keep LICENSE and NOTICE).

## Users

Designers and design engineers who build interfaces together with AI coding agents (Claude Code, Codex, Cursor, OpenCode, VS Code). They sit in a long working session with the editor on one side and an agent on the other, and expect the agent to read and write the same canvas they are editing.

## Product Purpose

Markup is an open-source, functionally faithful counterpart to Paper (paper.design): a design canvas where the design is real HTML/CSS, so it moves into code without translation and agents can edit it directly through MCP. The full feature target lives in the feature list document (claude.ai artifact "Paper (paper.design) – пълен списък с функции", sections 1–22).

Success: an agent connected through `markup mcp` can do everything Paper's 41 MCP tools allow, a person can do everything in the editor that Paper allows, and both can do it offline.

## Positioning

- Open source and self-hostable; no closed cloud required.
- No MCP call limits (Paper Free caps at 100 calls per week).
- Local-first: full editing offline, sync when connected.
- Every change, human or agent, is recorded: version history plus a visible per-file agent action log, with per-actor undo.

## Operating Context

- Three deliverables: the app (web + desktop), the Chrome extension, the MCP server/CLI.
- Agents connect over stdio (`markup mcp`); the CLI bridges to whichever editor window has the file open.
- Files live locally first (`.markup` documents); cloud teams, roles and sharing come in phase 2.

## Capabilities and Constraints

- Feature parity target: the Paper feature list, including flex layout, rich text, tokens/themes, OKLCH + Display P3 color, vectors, shaders, comments, multiplayer, export (PNG/JPG/WebP/AVIF/SVG/PDF/MP4/WebM), copy as React/Tailwind.
- MCP tool surface mirrors Paper's tool names and semantics so existing agent prompts transfer.
- Product names: `markup://` deep links, `markup` CLI, `markup-asset://` and `markup-gen://` URL schemes.
- Undecided: hosted offering and pricing, AI image model providers, license (MIT vs Apache 2.0).

## Brand Commitments

- Name: Markup. Existing mark: `assets/icon.svg`.
- Same functions and interaction patterns as Paper, but its own visual identity: no Paper logo, colors, icons, copy or assets.

## Evidence on Hand

- Feature list document (artifact SNqrCKg8QidtJfggPxJWPy).
- Paper MCP tool schemas (captured in sections 18–19 of that document).
- No users, testimonials, benchmarks or screenshots exist yet; do not fabricate them.

## Product Principles

1. The design is the code: whatever the canvas shows is valid HTML/CSS that copies out unchanged.
2. Agents are first-class collaborators, and their work is always visible, attributable and reversible.
3. Local-first: nothing a person makes depends on a server being up.
4. Parity before invention: match Paper's behavior and shortcuts first, then improve where the positioning says so.

## Accessibility & Inclusion

Keyboard-complete editor (every tool and panel reachable without a mouse), respects reduced-motion (including agent animations), and supports non-Latin text input (CJK, Cyrillic, diacritics).
