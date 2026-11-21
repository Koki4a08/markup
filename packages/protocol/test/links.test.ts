import { describe, expect, it } from 'vitest';
import { nodeLink, pageLink, parseMarkupLink } from '../src/index';

describe('markup links', () => {
  it('node and page links round-trip', () => {
    expect(nodeLink('f1', 'n_2-x')).toBe('markup://file/f1/node/n_2-x');
    expect(pageLink('f1', 'p1')).toBe('markup://file/f1/page/p1');
    expect(parseMarkupLink(nodeLink('f1', 'n_2-x'))).toEqual({ fileId: 'f1', nodeId: 'n_2-x' });
    expect(parseMarkupLink(pageLink('f1', 'p1'))).toEqual({ fileId: 'f1', pageId: 'p1' });
  });

  it('accepts file links and route paths', () => {
    expect(parseMarkupLink('markup://file/f1')).toEqual({ fileId: 'f1' });
    expect(parseMarkupLink('  markup://file/f1/  ')).toEqual({ fileId: 'f1' });
    expect(parseMarkupLink('/file/f1')).toEqual({ fileId: 'f1' });
    expect(parseMarkupLink('/file/f1/node/n1')).toEqual({ fileId: 'f1', nodeId: 'n1' });
  });

  it('rejects bare ids and other schemes', () => {
    expect(parseMarkupLink('n1')).toBeNull();
    expect(parseMarkupLink('')).toBeNull();
    expect(parseMarkupLink('https://file/f1/node/n1')).toBeNull();
    expect(parseMarkupLink('paper://file/f1')).toBeNull();
    expect(parseMarkupLink('markup://file/')).toBeNull();
    expect(parseMarkupLink('markup://file/f1/node/')).toBeNull();
    expect(parseMarkupLink('markup://file/f1/other/x')).toBeNull();
  });
});
