import { createHash } from 'node:crypto';

export interface FingerprintMedia {
  type: 'image' | 'video';
  url: string;
}

function normalizeText(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function normalizeMediaUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  url.search = '';

  return url.toString();
}

export function createContentFingerprint(input: {
  text?: string;
  media?: FingerprintMedia[];
}): string {
  const normalized = {
    text: normalizeText(input.text),
    media: (input.media ?? []).map((item) => ({
      type: item.type,
      url: normalizeMediaUrl(item.url),
    })),
  };

  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}
