import { describe, expect, it } from 'vitest';

import { isBearerAuthorized, isOwnerAuthorized } from '../src/http/auth.js';

describe('HTTP auth', () => {
  it('authorizes the expected bearer token only', () => {
    expect(isBearerAuthorized('Bearer abc123', 'abc123')).toBe(true);
    expect(isBearerAuthorized('Bearer wrong', 'abc123')).toBe(false);
    expect(isBearerAuthorized(undefined, 'abc123')).toBe(false);
  });

  it('authorizes owner basic auth', () => {
    const credentials = Buffer.from('owner:correct horse battery staple').toString('base64');

    expect(
      isOwnerAuthorized(`Basic ${credentials}`, 'correct horse battery staple'),
    ).toBe(true);
  });

  it('rejects the wrong owner username or password', () => {
    const wrongUser = Buffer.from('admin:password').toString('base64');
    const wrongPassword = Buffer.from('owner:wrong').toString('base64');

    expect(isOwnerAuthorized(`Basic ${wrongUser}`, 'password')).toBe(false);
    expect(isOwnerAuthorized(`Basic ${wrongPassword}`, 'password')).toBe(false);
  });
});
