import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = 'v1';

export class TokenCipherError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TokenCipherError';
  }
}

export function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[a-fA-F0-9]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed.replace(/^base64:/, ''), 'base64');

  if (key.length !== KEY_BYTES) {
    throw new TokenCipherError('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (64-char hex or base64).');
  }

  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new TokenCipherError('Encryption key must be exactly 32 bytes.');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new TokenCipherError('Encryption key must be exactly 32 bytes.');

  const [version, ivEncoded, tagEncoded, ciphertextEncoded, extra] = payload.split('.');
  if (version !== VERSION || !ivEncoded || !tagEncoded || ciphertextEncoded === undefined || extra !== undefined) {
    throw new TokenCipherError('Encrypted token payload has an invalid format.');
  }

  try {
    const iv = Buffer.from(ivEncoded, 'base64url');
    const authTag = Buffer.from(tagEncoded, 'base64url');
    const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');

    if (iv.length !== IV_BYTES) throw new TokenCipherError('Encrypted token payload has an invalid IV.');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof TokenCipherError) throw error;
    throw new TokenCipherError('Encrypted token could not be authenticated or decrypted.');
  }
}
