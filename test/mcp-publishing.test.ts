import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildMcpServer, type McpDependencies } from '../src/mcp/build-server.js';
import { ThreadsPublicationUncertainError } from '../src/providers/threads/publication-error.js';

const accountId = '00000000-0000-4000-8000-000000000001';
type Tool = (input: Record<string, unknown>) => Promise<{
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

function setup() {
  const guard = {
    reserve: vi.fn().mockResolvedValue({
      provider: 'threads',
      fingerprint: 'fingerprint',
      reservationId: 'reservation-id',
    }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const threads = {
    publish: vi.fn().mockResolvedValue({
      providerPostId: 'post-id',
      socialAccountId: accountId,
      quota: { usageBeforePublish: 0, total: 250, durationSeconds: 86400 },
    }),
  };
  const scheduler = {
    schedule: vi.fn().mockResolvedValue({
      id: 'scheduled-id',
      socialAccountId: accountId,
      scheduledAt: new Date(),
      status: 'scheduled',
    }),
  };
  const registered = vi.spyOn(McpServer.prototype, 'registerTool');
  buildMcpServer({ publishingGuard: guard, threads, scheduler } as unknown as McpDependencies);
  const tool = (name: string) =>
    registered.mock.calls.find((call) => call[0] === name)![2] as unknown as Tool;
  return { guard, threads, scheduler, tool };
}

afterEach(() => vi.restoreAllMocks());

describe('MCP publication reservations', () => {
  it('releases content after successful immediate publication', async () => {
    const { guard, tool } = setup();
    const result = await tool('publish_post')({
      account_id: accountId,
      text: 'hello',
      allow_duplicate: false,
    });
    expect(result.isError).not.toBe(true);
    expect(guard.release).toHaveBeenCalledWith('reservation-id');
  });

  it('releases content after a confirmed pre-publication failure', async () => {
    const { guard, threads, tool } = setup();
    threads.publish.mockRejectedValue(new Error('No active connection'));
    expect((await tool('publish_post')({ account_id: accountId, text: 'hello' })).isError).toBe(
      true,
    );
    expect(guard.release).toHaveBeenCalledWith('reservation-id');
  });

  it('retains reservations and warns clients against retrying uncertain publications', async () => {
    const { guard, threads, tool } = setup();
    threads.publish.mockRejectedValue(new ThreadsPublicationUncertainError('known-post-id'));
    const result = await tool('publish_post')({ account_id: accountId, text: 'hello' });
    expect(result.structuredContent).toMatchObject({
      error: 'publication_unconfirmed',
      provider_post_id: 'known-post-id',
      retry_safe: false,
    });
    expect(guard.release).not.toHaveBeenCalled();
  });

  it('releases the reservation only after scheduling has been persisted', async () => {
    const { guard, scheduler, tool } = setup();
    await tool('schedule_post')({
      account_id: accountId,
      text: 'hello',
      scheduled_at: new Date(Date.now() + 60000).toISOString(),
    });
    expect(scheduler.schedule.mock.invocationCallOrder[0]).toBeLessThan(
      guard.release.mock.invocationCallOrder[0]!,
    );
    expect(guard.release).toHaveBeenCalledWith('reservation-id');
  });

  it('releases the reservation after a scheduling failure', async () => {
    const { guard, scheduler, tool } = setup();
    scheduler.schedule.mockRejectedValue(new Error('Queue unavailable'));
    const result = await tool('schedule_post')({
      account_id: accountId,
      text: 'hello',
      scheduled_at: new Date(Date.now() + 60000).toISOString(),
    });
    expect(result.isError).toBe(true);
    expect(guard.release).toHaveBeenCalledWith('reservation-id');
  });
});
