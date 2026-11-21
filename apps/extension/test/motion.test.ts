import { describe, expect, it } from 'vitest';
import { cssAnimationRecords, cssProp, documentMotionCss, KeyframesRegistry, motionDecls, parseInline, recordOf, restingDecls, revealRecord } from '../src/capture/motion';
import { animatedVarDecls, resolveVars, ruleMatches } from '../src/capture/motionVars';
import { animatedWebp, fitFrames, webpChunks } from '../src/capture/motionClip';

/** A stand-in for a live Animation, as getAnimations() returns it. */
function anim(keyframes: Record<string, unknown>[], timing: Record<string, unknown>, extra: Record<string, unknown> = {}): Animation {
  return {
    playbackRate: 1,
    effect: { getKeyframes: () => keyframes, getTiming: () => ({ delay: 0, iterations: 1, direction: 'normal', fill: 'none', easing: 'linear', ...timing }) },
    ...extra,
  } as unknown as Animation;
}

const style = (map: Record<string, string>) => ({ getPropertyValue: (p: string) => map[p] ?? '' }) as unknown as CSSStyleDeclaration;

describe('motion records', () => {
  it('a CSS fade-in keeps its keyframes, per-keyframe easing, delay and fill', () => {
    const r = recordOf(
      anim(
        [
          { offset: 0, computedOffset: 0, easing: 'ease-out', composite: 'auto', opacity: '0', transform: 'translateY(24px)' },
          { offset: 1, computedOffset: 1, easing: 'linear', composite: 'auto', opacity: '1', transform: 'none' },
        ],
        { duration: 600, delay: 150, fill: 'both' },
        { animationName: 'fadeInUp' },
      ),
    )!;
    expect(r).toMatchObject({ label: 'fadeInUp', duration: 600, delay: 150, fill: 'both', iterations: 1 });
    const registry = new KeyframesRegistry();
    const decls = Object.fromEntries(motionDecls([r], registry));
    expect(decls['animation-name']).toMatch(/^mk-fadeInUp-[a-z0-9]+$/);
    expect(decls).toMatchObject({ 'animation-duration': '600ms', 'animation-delay': '150ms', 'animation-fill-mode': 'both', 'animation-timing-function': 'linear', 'animation-iteration-count': '1' });
    expect(registry.css()).toBe(`@keyframes ${decls['animation-name']}{0%{opacity:0;transform:translateY(24px);animation-timing-function:ease-out}100%{opacity:1;transform:none}}`);
  });

  it('a Web Animation eases its whole iteration; an infinite loop stays infinite and playback rate scales time', () => {
    const r = recordOf(
      anim(
        [
          { offset: 0, easing: 'linear', filter: 'blur(10px)' },
          { offset: 1, easing: 'linear', filter: 'blur(0px)' },
        ],
        { duration: 1000, iterations: Infinity, easing: 'cubic-bezier(0.2, 0, 0, 1)', direction: 'alternate' },
        { playbackRate: 2 },
      ),
    )!;
    expect(r.duration).toBe(500);
    expect(r.frames[0]!.easing).toBe('cubic-bezier(0.2, 0, 0, 1)');
    const decls = Object.fromEntries(motionDecls([r], new KeyframesRegistry()));
    expect(decls['animation-iteration-count']).toBe('infinite');
    expect(decls['animation-direction']).toBe('alternate');
  });

  it('drops keyframe values the paste side would reject, and animations with nothing left', () => {
    expect(recordOf(anim([{ offset: 0, backgroundImage: 'url(https://x.test/a.png)' }], { duration: 300 }))).toBeNull();
    expect(recordOf(anim([{ offset: 0, opacity: '0' }], { duration: 0 }))).toBeNull();
  });

  it('the same motion on many elements is one rule; different ones never share a name', () => {
    const registry = new KeyframesRegistry();
    const make = (to: string) => recordOf(anim([{ offset: 0, opacity: '0' }, { offset: 1, opacity: to }], { duration: 300 }, { animationName: 'fade' }))!;
    const a = registry.add(make('1'));
    expect(registry.add(make('1'))).toBe(a);
    expect(registry.add(make('0.5'))).not.toBe(a);
    expect(registry.size).toBe(2);
  });

  it('camelCase keyframe keys become CSS properties', () => {
    expect(cssProp('backgroundColor')).toBe('background-color');
    expect(cssProp('webkitMaskImage')).toBe('-webkit-mask-image');
    expect(cssProp('cssFloat')).toBe('float');
    expect(cssProp('--glow')).toBe('--glow');
  });
});

describe('ended CSS animations', () => {
  it('are rebuilt from the @keyframes of the page and the computed animation-* lists', async () => {
    document.head.innerHTML = '<style>@media (min-width: 1px) { @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); animation-timing-function: ease-in } 50%, 75% { opacity: 0.8 } to { opacity: 1; color: var(--brand) } } }</style>';
    const rules = (await documentMotionCss(document, async () => null)).keyframes;
    document.head.innerHTML = '';
    const cs = style({
      'animation-name': 'fadeUp, gone',
      'animation-duration': '0.8s, 1s',
      'animation-delay': '120ms',
      'animation-iteration-count': '1',
      'animation-direction': 'normal',
      'animation-fill-mode': 'none',
      'animation-timing-function': 'cubic-bezier(0.4, 0, 0.2, 1), ease',
      'animation-play-state': 'running',
    });
    const [r, ...rest] = cssAnimationRecords(cs, (n) => rules.get(n));
    expect(rest).toHaveLength(0); // "gone" has no rule
    expect(r).toMatchObject({ label: 'fadeUp', duration: 800, delay: 120, iterations: 1, fill: 'none' });
    expect(r!.frames.map((f) => f.offset)).toEqual([0, 0.5, 0.75, 1]);
    expect(r!.frames[0]!.easing).toBe('ease-in');
    expect(r!.frames[1]!.easing).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    // A var() the pasted layer cannot resolve is left out.
    expect(r!.frames[3]!.props).toEqual([['opacity', '1']]);
    expect(cssAnimationRecords(cs, (n) => rules.get(n), new Set(['fadeUp']))).toHaveLength(0);
  });
});

describe('script-driven reveals', () => {
  it('a fade and blur in through the inline style becomes an entrance animation', () => {
    const before = parseInline('opacity: 0; transform: translate3d(0px, 40px, 0px); filter: blur(8px)');
    const r = revealRecord(before, style({ opacity: '1', transform: 'none', filter: 'blur(0px)' }), 640)!;
    expect(r.duration).toBe(640);
    expect(r.frames[0]!.props).toEqual([
      ['opacity', '0'],
      ['transform', 'translate3d(0px, 40px, 0px)'],
      ['filter', 'blur(8px)'],
    ]);
    expect(r.frames[1]!.props).toEqual([
      ['opacity', '1'],
      ['transform', 'none'],
      ['filter', 'blur(0px)'],
    ]);
  });

  it('a transform that only moves (parallax) is not a reveal', () => {
    expect(revealRecord(parseInline('transform: translateY(120px)'), style({ opacity: '1', transform: 'matrix(1, 0, 0, 1, 0, 30)' }), 2000)).toBeNull();
  });
});

/** A minimal still WebP as canvas.toBlob makes it: RIFF, then one VP8 chunk (or VP8X + ALPH + VP8). */
function still(payload: number[], alpha = false): Uint8Array {
  const chunk = (id: string, data: number[]) => {
    const size = data.length;
    return [...id].map((c) => c.charCodeAt(0)).concat([size & 0xff, (size >> 8) & 0xff, 0, 0], data, size & 1 ? [0] : []);
  };
  const body = [...'WEBP'].map((c) => c.charCodeAt(0)).concat(alpha ? chunk('VP8X', [0x10, 0, 0, 0, 1, 0, 0, 1, 0, 0]).concat(chunk('ALPH', [7])) : [], chunk('VP8 ', payload));
  return Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([body.length & 0xff, (body.length >> 8) & 0xff, 0, 0], body));
}

describe('animated WebP clips', () => {
  it('puts still frames into one looping animation', () => {
    const webp = animatedWebp([still([1, 2, 3]), still([4, 5, 6, 7], true)], 320, 180, 66.7)!;
    const chunks = webpChunks(webp)!;
    expect(chunks.map((c) => c.id)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF']);
    const vp8x = chunks[0]!.raw;
    expect(vp8x[8]! & 0b10).toBe(0b10); // animation
    expect(vp8x[8]! & 0b10000).toBe(0b10000); // alpha (a frame has ALPH)
    expect(vp8x[12]! | (vp8x[13]! << 8)).toBe(319);
    const anmf = chunks[2]!.raw;
    expect(anmf[8 + 12]! | (anmf[8 + 13]! << 8)).toBe(67); // duration in ms
    expect(anmf[8 + 15]).toBe(0b10); // no blending: each frame replaces the last
    // RIFF size covers the whole file.
    expect(webp[4]! | (webp[5]! << 8) | (webp[6]! << 16)).toBe(webp.length - 8);
    // The second frame carries its alpha and image chunks.
    expect(String.fromCharCode(...chunks[3]!.raw.subarray(24, 28))).toBe('ALPH');
  });

  it('refuses frames that are not WebP (a browser without the encoder gives PNG)', () => {
    expect(animatedWebp([Uint8Array.from([137, 80, 78, 71, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], 10, 10, 50)).toBeNull();
  });

  it('keeps no clip for a canvas that never changes, and thins frames to fit the budget', () => {
    const same = Array.from({ length: 10 }, () => still([1, 2, 3]));
    expect(fitFrames(same, 66, 1e6)).toBeNull();
    const moving = Array.from({ length: 24 }, (_, i) => still([i, i, i, i, i, i, i, i]));
    const fit = fitFrames(moving, 50, 12 * moving[0]!.length)!;
    expect(fit.frames).toHaveLength(12);
    expect(fit.frameMs).toBe(100);
    expect(fitFrames(moving, 50, 10)).toBeNull();
  });
});

describe('scroll-driven animations', () => {
  const frames = [
    { offset: 0, easing: 'linear', opacity: '0', transform: 'translateY(40px)' },
    { offset: 1, easing: 'linear', opacity: '1', transform: 'none' },
  ];
  it('a view() timeline replays once as an entrance and rests at its last keyframe', () => {
    const r = recordOf(anim(frames, { duration: 'auto' }, { timeline: { source: {}, subject: {} }, animationName: 'reveal' }))!;
    expect(r).toMatchObject({ duration: 900, iterations: 1, fill: 'both', settles: true });
    expect(r.frames[0]!.easing).not.toBe('linear');
    expect(restingDecls([r])).toEqual([
      ['opacity', '1'],
      ['transform', 'none'],
    ]);
  });

  it('a scroll() timeline (progress bars, parallax) keeps its state and no animation', () => {
    expect(recordOf(anim(frames, { duration: 'auto' }, { timeline: { source: {} } }))).toBeNull();
  });

  it('an ended CSS animation on a view timeline is rebuilt as an entrance; one on scroll() is not', async () => {
    document.head.innerHTML = '<style>@keyframes up { from { opacity: 0 } to { opacity: 1 } }</style>';
    const rules = (await documentMotionCss(document, async () => null)).keyframes;
    document.head.innerHTML = '';
    const cs = (timeline: string) => style({ 'animation-name': 'up', 'animation-duration': 'auto', 'animation-timeline': timeline, 'animation-fill-mode': 'both' });
    expect(cssAnimationRecords(cs('view()'), (n) => rules.get(n))[0]).toMatchObject({ duration: 900, settles: true });
    expect(cssAnimationRecords(cs('--card-reveal'), (n) => rules.get(n))[0]).toMatchObject({ settles: true });
    expect(cssAnimationRecords(cs('scroll(root)'), (n) => rules.get(n))).toHaveLength(0);
  });
});

describe('animated custom properties (@property)', () => {
  it('keeps a rotating gradient border driven by its animated --angle', async () => {
    document.head.innerHTML = `<style>
      .card::before { background: conic-gradient(from var(--angle), var(--brand), transparent 30%); animation: spin 3s linear infinite }
      .card { color: var(--brand) }
      .other::before { background: conic-gradient(from var(--angle), red, blue) }
    </style>`;
    const css = await documentMotionCss(document, async () => null);
    css.properties.set('--angle', '@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }');
    document.head.innerHTML = '';
    document.body.innerHTML = '<div class="card"></div>';
    const card = document.querySelector('.card')!;
    const spin = recordOf(anim([{ offset: 0, '--angle': '0deg' }, { offset: 1, '--angle': '360deg' }], { duration: 3000, iterations: Infinity }, { animationName: 'spin' }))!;
    const cs = style({ '--angle': '127deg', '--brand': 'rgb(255, 0, 128)' });
    const { decls, rules } = animatedVarDecls(card, '::before', cs, [spin], css);
    expect(decls).toEqual([
      ['--angle', '127deg'],
      ['background', 'conic-gradient(from var(--angle), rgb(255, 0, 128), transparent 30%)'],
    ]);
    expect(rules.map(([n]) => n)).toEqual(['--angle']);
    // The element itself does not use --angle: nothing to keep there.
    expect(animatedVarDecls(card, '', cs, [spin], css).decls).toEqual([['--angle', '127deg']]);
    document.body.innerHTML = '';
  });

  it('other custom properties resolve to the element values, and an unresolvable one drops the declaration', () => {
    const cs = style({ '--brand': 'red' });
    const keep = new Set(['--angle']);
    expect(resolveVars('conic-gradient(from var(--angle), var(--brand), var(--x, blue))', cs, keep)).toBe('conic-gradient(from var(--angle), red, blue)');
    expect(resolveVars('linear-gradient(var(--missing), red)', cs, keep)).toBeNull();
  });

  it('matches rules for an element or its pseudo-elements only', () => {
    document.body.innerHTML = '<section><div class="card hot"></div></section>';
    const el = document.querySelector('.card')!;
    expect(ruleMatches(el, 'section .card.hot', '')).toBe(true);
    expect(ruleMatches(el, '.card::before', '')).toBe(false);
    expect(ruleMatches(el, '.nope, .card::before', '::before')).toBe(true);
    expect(ruleMatches(el, '.card::after', '::before')).toBe(false);
    document.body.innerHTML = '';
  });
});
