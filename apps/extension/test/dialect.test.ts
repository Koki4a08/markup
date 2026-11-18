import { parseHtml } from '@markup/doc';
import { describe, expect, it } from 'vitest';
import { capture } from '../src/capture/serialize';
import { fakeEnv } from './fakeEnv';
import { FIXTURES } from './fixtures';

const MARKER = '<!--markup:snapshot v1-->';
const UNSAFE = /javascript:|expression\(|-moz-binding|behavior\s*:|@import|image-set\(|\\/i;

describe('Markup dialect', () => {
  it('every fixture parses with no ignored styles', async () => {
    for (const f of FIXTURES) {
      document.body.innerHTML = f.html;
      const html = await capture(
        f.targets.map((id) => document.getElementById(id)!),
        fakeEnv(f.images),
        { title: f.name, url: 'https://example.test/' },
      );
      expect(html.startsWith(MARKER), f.name).toBe(true);
      const { specs, ignored } = parseHtml(html.slice(MARKER.length));
      expect(ignored, f.name).toEqual([]);
      expect(specs, f.name).toHaveLength(1);
      expect(specs[0]!.type, f.name).toBe('frame');
      expect(html, f.name).not.toMatch(UNSAFE);
      expect(html, f.name).not.toMatch(/(style="|;)margin|display:\s*(inline|grid|table)/);
    }
  });
});
