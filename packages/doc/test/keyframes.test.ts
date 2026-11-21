import { describe, expect, it } from 'vitest';
import { addKeyframes, keyframeRules, MarkupDoc, splitKeyframes } from '../src';

const fade = '@keyframes mk-fadeIn-1a{0%{opacity:0;animation-timing-function:ease-out}100%{opacity:1}}';
const blur = '@keyframes mk-blurIn-2b{0%{filter:blur(12px);opacity:0}100%{filter:blur(0px);opacity:1}}';

describe('embedded keyframes', () => {
  it('splits a stylesheet into whole @keyframes rules', () => {
    expect(splitKeyframes(`${fade}\n${blur}`)).toEqual([fade, blur]);
  });

  it('stores each rule once by name, outside history', () => {
    const doc = new MarkupDoc();
    const before = doc.log().length;
    expect(addKeyframes(doc, fade + blur)).toBe(2);
    expect(addKeyframes(doc, fade)).toBe(0);
    expect(keyframeRules(doc)).toEqual([fade, blur]);
    expect(doc.log()).toHaveLength(before);
  });

  it('never stores a rule that loads a resource or escapes its style element', () => {
    const doc = new MarkupDoc();
    expect(addKeyframes(doc, '@keyframes a{0%{background:url(https://evil.test/x.png)}}')).toBe(0);
    expect(addKeyframes(doc, '@keyframes b{0%{opacity:0}}</style><script>alert(1)</script>{}')).toBe(1);
    expect(keyframeRules(doc)).toEqual(['@keyframes b{0%{opacity:0}}']);
    expect(addKeyframes(doc, '@keyframes c{0%{content:"\\3c"}}')).toBe(0);
  });

  it('stores @property registrations, whose syntax names a type in angle brackets', () => {
    const doc = new MarkupDoc();
    const angle = '@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }';
    expect(addKeyframes(doc, angle + fade)).toBe(2);
    expect(keyframeRules(doc)).toEqual([angle, fade]);
    expect(addKeyframes(doc, '@property --x { syntax: "</style><script>"; inherits: false; }')).toBe(0);
  });
});
