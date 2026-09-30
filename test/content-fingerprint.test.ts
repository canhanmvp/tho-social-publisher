import { describe, expect, it } from 'vitest';

import { createContentFingerprint } from '../src/guardrails/content-fingerprint.js';

describe('content fingerprint', () => {
  it('normalizes whitespace, case, and unicode compatibility forms', () => {
    const first = createContentFingerprint({ text: '  Hello   WORLD  ' });
    const second = createContentFingerprint({ text: 'hello world' });

    expect(first).toBe(second);
  });

  it('ignores image URL query strings and fragments', () => {
    const first = createContentFingerprint({
      text: 'caption',
      media: [{ type: 'image', url: 'https://cdn.example.com/image.png?token=one#x' }],
    });
    const second = createContentFingerprint({
      text: 'CAPTION',
      media: [{ type: 'image', url: 'https://cdn.example.com/image.png?token=two' }],
    });

    expect(first).toBe(second);
  });

  it('changes when substantive text or media path changes', () => {
    const textA = createContentFingerprint({ text: 'alpha' });
    const textB = createContentFingerprint({ text: 'beta' });
    const imageA = createContentFingerprint({
      media: [{ type: 'image', url: 'https://cdn.example.com/a.png' }],
    });
    const imageB = createContentFingerprint({
      media: [{ type: 'image', url: 'https://cdn.example.com/b.png' }],
    });

    expect(textA).not.toBe(textB);
    expect(imageA).not.toBe(imageB);
  });
});
