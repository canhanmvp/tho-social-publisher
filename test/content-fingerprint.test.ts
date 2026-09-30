import { describe, expect, it } from 'vitest';

import { createContentFingerprint } from '../src/guardrails/content-fingerprint.js';

describe('content fingerprint', () => {
  it('normalizes whitespace, case, and unicode compatibility forms', () => {
    const first = createContentFingerprint({ text: '  Hello   WORLD  ' });
    const second = createContentFingerprint({ text: 'hello world' });

    expect(first).toBe(second);
  });

  it('ignores media URL query strings and fragments', () => {
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

  it('includes media type and ordered paths in the fingerprint', () => {
    const image = createContentFingerprint({
      media: [{ type: 'image', url: 'https://cdn.example.com/a' }],
    });
    const video = createContentFingerprint({
      media: [{ type: 'video', url: 'https://cdn.example.com/a' }],
    });
    const ordered = createContentFingerprint({
      media: [
        { type: 'image', url: 'https://cdn.example.com/a' },
        { type: 'video', url: 'https://cdn.example.com/b' },
      ],
    });
    const reversed = createContentFingerprint({
      media: [
        { type: 'video', url: 'https://cdn.example.com/b' },
        { type: 'image', url: 'https://cdn.example.com/a' },
      ],
    });

    expect(image).not.toBe(video);
    expect(ordered).not.toBe(reversed);
  });
});
