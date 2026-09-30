import { describe, expect, it } from 'vitest';

import { hashOAuthState } from '../src/oauth/oauth-state-store.js';

describe('OAuth state hashing', () => {
  it('is deterministic without storing the raw OAuth state', () => {
    const raw = 'state-value-that-should-not-be-stored';

    expect(hashOAuthState(raw)).toHaveLength(64);
    expect(hashOAuthState(raw)).toBe(hashOAuthState(raw));
    expect(hashOAuthState(raw)).not.toContain(raw);
  });
});
