<img src="assets/icon.svg" width="64" height="64" alt="">

# Markup

Markup is an open-source design canvas where every layer is HTML and CSS. It runs in the browser or as a Tauri desktop app, and coding agents reach the open file through `markup mcp`, a local stdio MCP server that can read designs, write HTML into them, take screenshots and export files. A Chrome extension captures live web pages as editable Markup layers.

## Development

```sh
pnpm install
pnpm --filter app dev            # editor in the browser at http://localhost:5173
pnpm --filter app desktop:dev    # desktop app (needs Rust and Bun)
```

The desktop scripts first compile the `markup` CLI into a native binary with `pnpm --filter @markup/mcp compile` (Bun), which Tauri bundles as a sidecar. `pnpm --filter app desktop:build` builds the installer.

## Connecting an agent

In the desktop app, open **Connect an agent** in the editor top bar and click **Add to** next to your agent. The web build shows the same setup as commands and snippets to copy.

From a terminal:

```sh
pnpm --filter @markup/mcp build           # builds packages/mcp/dist/cli.js
node packages/mcp/dist/cli.js install claude-code
```

`markup install <agent>` accepts `claude-code`, `cursor`, `vscode`, `codex`, `opencode`, or `print` (prints every snippet without changing anything). It merges a `markup` entry into the agent's user config and writes `<file>.bak` before changing an existing file. Claude Code is set up by running `claude mcp add --scope user markup -- <command> mcp`. Pass `--command <path>` to point agents at a different `markup` binary.

## Loading the extension

```sh
pnpm --filter extension build
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select `apps/extension/dist`.

## Tests

```sh
pnpm vitest run
pnpm -r typecheck
```
