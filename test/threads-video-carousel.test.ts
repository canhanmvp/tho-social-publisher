import { describe, expect, it, vi } from 'vitest';

import { ThreadsClient } from '../src/providers/threads/threads-client.js';

const config = {
  clientId: '123456',
  clientSecret: 'top-secret',
  redirectUri: 'https://social.example.com/oauth/threads/callback',
};

describe('Threads video and carousel client', () => {
  it('creates a video container with the official VIDEO parameters', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'video-container' }), { status: 200 }),
    );
    const client = new ThreadsClient(config, fetchFn);

    await expect(
      client.createVideoContainer('token', {
        videoUrl: 'https://cdn.example.com/demo.mp4',
        text: 'video caption',
        altText: 'demo video',
      }),
    ).resolves.toEqual({ id: 'video-container' });

    const [requestUrl] = fetchFn.mock.calls[0]!;
    const url = new URL(String(requestUrl));

    expect(url.pathname).toBe('/me/threads');
    expect(url.searchParams.get('media_type')).toBe('VIDEO');
    expect(url.searchParams.get('video_url')).toBe('https://cdn.example.com/demo.mp4');
    expect(url.searchParams.get('text')).toBe('video caption');
    expect(url.searchParams.get('alt_text')).toBe('demo video');
  });

  it('marks media as a carousel item when requested', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'child-1' }), { status: 200 }),
    );
    const client = new ThreadsClient(config, fetchFn);

    await client.createMediaContainer('token', {
      type: 'image',
      url: 'https://cdn.example.com/one.jpg',
      isCarouselItem: true,
    });

    const url = new URL(String(fetchFn.mock.calls[0]![0]));

    expect(url.searchParams.get('media_type')).toBe('IMAGE');
    expect(url.searchParams.get('is_carousel_item')).toBe('true');
  });

  it('creates a carousel container with 2-20 child IDs in order', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'carousel-1' }), { status: 200 }),
    );
    const client = new ThreadsClient(config, fetchFn);

    await expect(
      client.createCarouselContainer('token', {
        children: ['child-1', 'child-2', 'child-3'],
        text: 'carousel caption',
      }),
    ).resolves.toEqual({ id: 'carousel-1' });

    const url = new URL(String(fetchFn.mock.calls[0]![0]));

    expect(url.searchParams.get('media_type')).toBe('CAROUSEL');
    expect(url.searchParams.get('children')).toBe('child-1,child-2,child-3');
    expect(url.searchParams.get('text')).toBe('carousel caption');
  });

  it('rejects carousel sizes outside the official 2-20 range before a network call', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = new ThreadsClient(config, fetchFn);

    await expect(
      client.createCarouselContainer('token', { children: ['only-one'] }),
    ).rejects.toThrow('between 2 and 20');

    await expect(
      client.createCarouselContainer('token', {
        children: Array.from({ length: 21 }, (_, index) => `child-${index}`),
      }),
    ).rejects.toThrow('between 2 and 20');

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
