export const GUIDES: Record<string, string> = {
  'markup-mcp-instructions': `# Working in Markup over MCP

Markup is a design canvas whose layers are real HTML/CSS. You read and write the file the user has open, live, while they watch.

1. Orient: call get_basic_info first (file, pages, artboards, fonts, tokens). Call get_selection to see what the user is focused on. Use get_tree_summary before get_jsx; it is much cheaper.
2. New designs: write a short brief first (palette, type scale, spacing, direction) unless the file already has tokens. Reuse tokens through var(--token).
3. Create artboards with create_artboard. Default sizes: Desktop 1440x900, Tablet 768x1024, Mobile 390x844 (add a status bar: get_guide "mobile-status-bar").
4. Write incrementally: one visual group per write_html call (a header, one list row, a button bar). The user sees each call land.
5. Repeat elements by cloning: <x-markup-clone node-id="..." style="..."/> or duplicate_nodes, then set_text_content on the clones via descendantIdMap.
6. HTML dialect: inline style="" only; flex, padding and gap for layout; absolute position for decoration; no margin, display:inline, display:grid or <table>. layer-name="..." names layers. Local images: markup-asset:///absolute/path.
7. Review with get_screenshot after meaningful changes. When content clips, set height: "fit-content" with update_styles instead of guessing a height.
8. Repeated rows need fixed-width slots for icons and trailing actions (flexShrink: 0); gap alone does not align columns.
9. When done, ALWAYS call finish_working_on_nodes so your working indicator clears.
10. Every change you make is logged under your name and the user can revert it. Never show raw node IDs to the user.
11. When the user pastes a markup:// link, pass it as the nodeId; it identifies the file and the layer.`,
  'mobile-status-bar': `Paste-ready iOS-style status bar for a 390px wide artboard (write_html, insert as the first child):

<div layer-name="Status Bar" style="display:flex;justify-content:space-between;align-items:center;width:100%;height:54px;padding:0 24px 0 32px;flex-shrink:0">
  <span style="font-family:-apple-system,'SF Pro Text',Inter,sans-serif;font-size:17px;font-weight:600;color:#000">9:41</span>
  <div layer-name="Indicators" style="display:flex;gap:6px;align-items:center">
    <svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="#000"/><rect x="5" y="5" width="3" height="7" rx="1" fill="#000"/><rect x="10" y="2.5" width="3" height="9.5" rx="1" fill="#000"/><rect x="15" y="0" width="3" height="12" rx="1" fill="#000"/></svg>
    <svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 11.5 10.5 9a3.5 3.5 0 0 0-5 0L8 11.5Zm-4.2-4.2a6 6 0 0 1 8.4 0l1.4-1.4a8 8 0 0 0-11.2 0l1.4 1.4ZM.9 4.4a10 10 0 0 1 14.2 0l1.4-1.4a12 12 0 0 0-17 0l1.4 1.4Z" fill="#000"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke="#000" stroke-opacity="0.35" fill="none"/><rect x="2" y="2" width="20" height="9" rx="2" fill="#000"/><path d="M25 4.5v4a2 2 0 0 0 0-4Z" fill="#000" fill-opacity="0.4"/></svg>
  </div>
</div>`,
};

export function guide(topic: string): string {
  return GUIDES[topic] ?? `Unknown guide "${topic}". Available topics: ${Object.keys(GUIDES).join(', ')}.`;
}
