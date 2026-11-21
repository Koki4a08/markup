import { describe, expect, it } from 'vitest';
import { resolveConflicts } from '../src/panels/conflicts';

describe('resolveConflicts', () => {
  it('a written shorthand clears its stored longhands', () => {
    expect(resolveConflicts({ rowGap: '4px', columnGap: '4px', color: 'red' }, { gap: '8px' })).toEqual({ gap: '8px', rowGap: null, columnGap: null });
  });

  it('a written longhand splits a stored plain shorthand without a rendered layer', () => {
    expect(resolveConflicts({ background: '#fff' }, { backgroundColor: '#000' })).toEqual({ backgroundColor: '#000', background: null });
    expect(resolveConflicts({ borderRadius: '4px 8px' }, { borderTopLeftRadius: '0px' })).toEqual({
      borderTopLeftRadius: '0px',
      borderRadius: null,
      borderTopRightRadius: '8px',
      borderBottomRightRadius: '4px',
      borderBottomLeftRadius: '8px',
    });
  });

  it('splits from computed values when the layer is rendered, skipping defaults', () => {
    const el = document.createElement('div');
    el.style.background = 'url(a.png) no-repeat';
    document.body.appendChild(el);
    const out = resolveConflicts({ background: 'url(a.png) no-repeat' }, { backgroundColor: '#000' }, getComputedStyle(el));
    expect(out.background).toBeNull();
    expect(out.backgroundColor).toBe('#000');
    expect(out.backgroundImage).toContain('a.png');
    expect(out.backgroundRepeat).toBe('no-repeat');
    el.remove();
  });

  it('leaves a gradient shorthand alone when nothing rendered can split it', () => {
    expect(resolveConflicts({ background: 'linear-gradient(red, blue)' }, { backgroundColor: '#000' })).toEqual({ backgroundColor: '#000' });
  });
});
