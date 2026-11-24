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

Without the app or the repository, one command installs the `markup` CLI (a self-contained binary in `~/.markup/bin`, no Node needed) and connects the agents it finds:

```sh
curl -fsSL https://markup.here/install.sh | sh      # macOS and Linux
irm https://markup.here/install.ps1 | iex           # Windows PowerShell
```

Then:

```sh
markup setup [agent...]       # find agents and connect them (interactive; --yes for all found)
markup status                 # each agent's config, and whether Markup is open
markup update                 # replace the CLI with the newest release
markup uninstall [agent...]   # remove markup from agents' configs
```

Agents: `claude-code`, `cursor`, `vscode`, `codex`, `opencode`, `claude-desktop`, `windsurf`, `gemini`. Every config change keeps the previous file as `<file>.bak`; Claude Code is set up with `claude mcp add --scope user markup -- <command> mcp`. `markup install <agent>` connects one agent without questions (the desktop app uses it), and `markup install print` prints every snippet without changing anything. Pass `--command <path>` to point agents at a different `markup` binary.

The install scripts live in `../markup-website/public/` and download the `markup-cli-*` assets of the latest GitHub release, which `.github/workflows/release.yml` builds for every platform.

From a clone:

```sh
pnpm --filter @markup/mcp build           # builds packages/mcp/dist/cli.js
node packages/mcp/dist/cli.js setup
```

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
