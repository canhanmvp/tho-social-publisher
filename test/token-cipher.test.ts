import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret, parseEncryptionKey, TokenCipherError } from '../src/security/token-cipher.js';

describe('token cipher', () => {
  it('round-trips a token with AES-256-GCM', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('secret-access-token', key);
    expect(encrypted).not.toContain('secret-access-token');
    expect(decryptSecret(encrypted, key)).toBe('secret-access-token');
  });

  it('rejects a tampered payload', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('secret-access-token', key);
    const parts = encrypted.split('.');
    const ciphertext = parts.at(-1) ?? '';
    parts[parts.length - 1] = `${ciphertext.slice(0, -1)}A`;
    expect(() => decryptSecret(parts.join('.'), key)).toThrow(TokenCipherError);
  });

  it('parses 32-byte base64 and hex keys', () => {
    const raw = randomBytes(32);
    expect(parseEncryptionKey(raw.toString('base64'))).toEqual(raw);
    expect(parseEncryptionKey(raw.toString('hex'))).toEqual(raw);
  });

  it('rejects keys with the wrong size', () => {
    expect(() => parseEncryptionKey(Buffer.from('too-short').toString('base64'))).toThrow(TokenCipherError);
  });
});
