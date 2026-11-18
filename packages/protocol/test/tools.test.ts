import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BRIDGE_PORT, DOM_TOOLS, EDITOR_TOOLS, EXPORT_TOOLS, FONT_TOOLS, ALL_TOOLS, RESOURCE_TOOLS, tools } from '../src/index';

describe('tool schemas', () => {
  it('every tool has description and object schema', () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.description.length, name).toBeGreaterThan(20);
      expect(tool.input).toBeInstanceOf(z.ZodObject);
    }
  });

  it("ALL_TOOLS matches Paper's 41", () => {
    const paper = [
      'archive_resources', 'arrange_pages', 'create_artboard', 'create_file', 'create_folder', 'create_page', 'create_tokens', 'delete_nodes',
      'duplicate_nodes', 'export', 'export_combined_pdf', 'find_nodes', 'finish_working_on_nodes', 'get_basic_info', 'get_children',
      'get_comment_thread', 'get_computed_styles', 'get_fill_image', 'get_font_family_info', 'get_guide', 'get_jsx', 'get_node_info',
      'get_screenshot', 'get_selection', 'get_tokens', 'get_tree_summary', 'list_comment_thread_authors', 'list_comment_threads',
      'list_resources', 'move_nodes', 'move_resources', 'open_file', 'rename_nodes', 'rename_resource', 'set_comment_thread_status',
      'set_text_content', 'set_tokens', 'unarchive_resources', 'update_pages', 'update_styles', 'write_html',
    ];
    expect(paper).toHaveLength(41);
    expect([...ALL_TOOLS].sort()).toEqual(paper);
    expect(Object.keys(tools).sort()).toEqual(paper);
  });

  it('write_html requires html, targetNodeId, mode', () => {
    const schema = tools.write_html.input;
    expect(schema.safeParse({ html: '<div/>', targetNodeId: 'x', mode: 'replace' }).success).toBe(true);
    expect(schema.safeParse({ html: '<div/>', targetNodeId: 'x' }).success).toBe(false);
    expect(schema.safeParse({ html: '<div/>', targetNodeId: 'x', mode: 'append' }).success).toBe(false);
  });

  it('create_artboard requires width and height', () => {
    expect(tools.create_artboard.input.safeParse({ name: 'A', styles: { width: '1440px' } }).success).toBe(false);
    expect(tools.create_artboard.input.safeParse({ name: 'A', styles: { width: '1440px', height: '900px' } }).success).toBe(true);
  });

  it('dom tools are part of the tool set and the port is fixed', () => {
    for (const t of DOM_TOOLS) expect(ALL_TOOLS).toContain(t);
    expect(BRIDGE_PORT).toBe(29980);
  });

  it('export accepts nodes-with-exports-only or per-node settings', () => {
    const { input } = tools.export;
    expect(input.safeParse({ nodes: 'nodes-with-exports-only' }).success).toBe(true);
    expect(input.safeParse({ nodes: { n1: [] } }).success).toBe(true);
    expect(input.safeParse({ nodes: { n1: [{ format: 'png', scale: '2x' }, { format: 'pdf', scale: '720p', pdfQuality: 'low' }] } }).success).toBe(true);
    expect(input.safeParse({ nodes: { n1: [{ format: 'gif', scale: '2x' }] } }).success).toBe(false);
    expect(input.safeParse({ nodes: { n1: [{ format: 'png', scale: '2' }] } }).success).toBe(false);
    expect(input.safeParse({ nodes: { n1: [{ format: 'mp4', scale: '1x', durationSeconds: 301 }] } }).success).toBe(false);
    expect(tools.export_combined_pdf.input.safeParse({ nodeIds: [] }).success).toBe(false);
    expect(tools.export.description).not.toContain('Desktop');
  });

  it('the editor answers dom, resource and font tools, and resource tools take no fileId', () => {
    expect([...EDITOR_TOOLS].sort()).toEqual([...DOM_TOOLS, ...RESOURCE_TOOLS, ...FONT_TOOLS, ...EXPORT_TOOLS].sort());
    expect(RESOURCE_TOOLS).toHaveLength(8);
    for (const t of RESOURCE_TOOLS.filter((t) => t !== 'open_file')) expect(Object.keys(tools[t].input.shape), t).not.toContain('fileId');
  });
});
