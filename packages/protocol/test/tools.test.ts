import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BRIDGE_PORT, DOM_TOOLS, PHASE1_TOOLS, tools } from '../src/index';

describe('tool schemas', () => {
  it('every tool has description and object schema', () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.description.length, name).toBeGreaterThan(20);
      expect(tool.input).toBeInstanceOf(z.ZodObject);
    }
  });

  it('covers the phase-1 tool set exactly', () => {
    expect(Object.keys(tools).sort()).toEqual([...PHASE1_TOOLS].sort());
    expect(PHASE1_TOOLS).toHaveLength(25);
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
    for (const t of DOM_TOOLS) expect(PHASE1_TOOLS).toContain(t);
    expect(BRIDGE_PORT).toBe(29980);
  });
});
