import { timingSafeEqual } from 'node:crypto';

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isBearerAuthorized(header: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken || !header) {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ? safeEqual(match[1], expectedToken) : false;
}

export function isOwnerAuthorized(
  header: string | undefined,
  expectedPassword: string | undefined,
): boolean {
  if (!expectedPassword || !header) {
    return false;
  }

  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match?.[1]) {
    return false;
  }

  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');

    if (separator < 0) {
      return false;
    }

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    return username === 'owner' && safeEqual(password, expectedPassword);
  } catch {
    return false;
  }
}
