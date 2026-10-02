import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { DuplicateContentError, PublishingGuard } from '../src/guardrails/publishing-guard.js';

// Model PostgreSQL's transaction-scoped advisory lock and committed rows. This
// exercises two independent connections rather than serializing tool calls.
function database() {
  const reservations: {
    id: string;
    accountId: string;
    provider: string;
    fingerprint: string;
    at: Date;
  }[] = [];
  let tail = Promise.resolve();
  const pool = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT provider'))
        return Promise.resolve({ rows: [{ provider: 'threads' }] });
      if (sql.includes('DELETE')) {
        const index = reservations.findIndex((row) => row.id === params?.[0]);
        if (index >= 0) reservations.splice(index, 1);
      }
      return Promise.resolve({ rows: [] });
    }),
    connect: vi.fn().mockImplementation(() => {
      let unlock: (() => void) | undefined;
      let pending: (typeof reservations)[number] | undefined;
      const client = {
        query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('pg_advisory_xact_lock')) {
            const previous = tail;
            tail = new Promise<void>((resolve) => {
              unlock = resolve;
            });
            await previous;
          } else if (sql.includes('SELECT *')) {
            const conflicts = reservations.filter(
              (row) =>
                row.provider === params[0] &&
                row.fingerprint === params[1] &&
                row.at >= (params[2] as Date) &&
                row.at <= (params[3] as Date),
            );
            return {
              rows: conflicts.map((row) => ({
                source: 'reserved',
                record_id: row.id,
                social_account_id: row.accountId,
                account_name: row.accountId,
                event_at: row.at,
              })),
            };
          } else if (sql.includes('INSERT INTO publishing_reservations')) {
            pending = {
              id: `reservation-${reservations.length + 1}`,
              accountId: params[0] as string,
              provider: params[1] as string,
              fingerprint: params[2] as string,
              at: params[3] as Date,
            };
            return { rows: [{ id: pending.id }] };
          } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (sql === 'COMMIT' && pending) reservations.push(pending);
            unlock?.();
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      return Promise.resolve(client as unknown as PoolClient);
    }),
  };
  return { pool, reservations, guard: new PublishingGuard(pool as unknown as Pool, 24) };
}

describe('atomic duplicate reservations', () => {
  it('accepts only one concurrent request for identical content on the same provider', async () => {
    const { guard, reservations } = database();
    const targetAt = new Date();
    const outcomes = await Promise.allSettled([
      guard.reserve({ socialAccountId: 'account-a', text: 'same content', targetAt }),
      guard.reserve({ socialAccountId: 'account-b', text: 'same content', targetAt }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(DuplicateContentError);
    expect(reservations).toHaveLength(1);
  });

  it('allows an explicit duplicate override and still reserves it against later accidental reuse', async () => {
    const { guard, reservations } = database();
    const input = { socialAccountId: 'account-a', text: 'same content', targetAt: new Date() };
    await guard.reserve(input);
    await guard.reserve({ ...input, allowDuplicate: true });
    expect(reservations).toHaveLength(2);
    await expect(guard.reserve(input)).rejects.toBeInstanceOf(DuplicateContentError);
  });

  it('releases a reservation after a confirmed failure so the content can be retried', async () => {
    const { guard, reservations } = database();
    const input = { socialAccountId: 'account-a', text: 'hello', targetAt: new Date() };
    const accepted = await guard.reserve(input);
    await guard.release(accepted.reservationId);
    expect(reservations).toHaveLength(0);
    await expect(guard.reserve(input)).resolves.toHaveProperty('reservationId');
  });

  it('keeps unconfirmed reservations visible to subsequent requests', async () => {
    const { guard } = database();
    const input = { socialAccountId: 'account-a', text: 'hello', targetAt: new Date() };
    await guard.reserve(input);
    await expect(guard.reserve(input)).rejects.toMatchObject({
      conflicts: [{ source: 'reserved', socialAccountId: 'account-a' }],
    });
  });

  it('does not turn a successful publication into a failure when cleanup is unavailable', async () => {
    const { guard, pool } = database();
    pool.query.mockRejectedValueOnce(new Error('Database unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(guard.release('reservation-id')).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});
