import type { Pool, PoolClient } from 'pg';

import type { SocialProvider } from '../domain/social-account.js';
import { createContentFingerprint, type FingerprintMedia } from './content-fingerprint.js';

export interface DuplicateConflict {
  source: 'published' | 'scheduled' | 'reserved';
  recordId: string;
  socialAccountId: string;
  accountName: string;
  eventAt: Date;
}

export interface PublishingGuardResult {
  provider: SocialProvider;
  fingerprint: string;
  duplicateConflicts: DuplicateConflict[];
  reservationId: string | null;
}

interface TargetAccountRow {
  provider: SocialProvider;
}

interface DuplicateRow {
  source: DuplicateConflict['source'];
  record_id: string;
  social_account_id: string;
  account_name: string;
  event_at: Date;
}

export class PublishingGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PublishingGuardError';
  }
}

export class DuplicateContentError extends PublishingGuardError {
  public constructor(
    public readonly conflicts: DuplicateConflict[],
    public readonly guardWindowHours: number,
  ) {
    super(
      `Substantially identical content is already published, scheduled, or awaiting publication confirmation on the same provider within ${guardWindowHours} hour(s). Use allow_duplicate only when this duplication is intentional.`,
    );
    this.name = 'DuplicateContentError';
  }
}

export class PublishingGuard {
  public constructor(
    private readonly pool: Pool,
    private readonly duplicateGuardHours: number,
  ) {}

  public async reserve(input: {
    socialAccountId: string;
    text?: string;
    media?: FingerprintMedia[];
    targetAt: Date;
    allowDuplicate?: boolean;
  }): Promise<PublishingGuardResult> {
    const target = await this.getTargetAccount(input.socialAccountId);
    const fingerprint = createContentFingerprint({
      ...(input.text ? { text: input.text } : {}),
      ...(input.media ? { media: input.media } : {}),
    });

    if (this.duplicateGuardHours === 0) {
      return {
        provider: target.provider,
        fingerprint,
        duplicateConflicts: [],
        reservationId: null,
      };
    }

    const windowMilliseconds = this.duplicateGuardHours * 60 * 60 * 1000;
    const start = new Date(input.targetAt.getTime() - windowMilliseconds);
    const end = new Date(input.targetAt.getTime() + windowMilliseconds);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize the check + durable reservation across every server instance.
      // No database lock is held during an external provider request.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `social-publish:${target.provider}:${fingerprint}`,
      ]);
      const conflicts = input.allowDuplicate
        ? []
        : await this.findDuplicateConflicts(client, target.provider, fingerprint, start, end);
      if (conflicts.length > 0) {
        throw new DuplicateContentError(conflicts, this.duplicateGuardHours);
      }
      await client.query(
        "DELETE FROM publishing_reservations WHERE target_at < now() - interval '168 hours'",
      );
      const result = await client.query<{ id: string }>(
        `INSERT INTO publishing_reservations (social_account_id, provider, content_fingerprint, target_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.socialAccountId, target.provider, fingerprint, input.targetAt],
      );
      const reservationId = result.rows[0]?.id;
      if (!reservationId) throw new PublishingGuardError('Failed to reserve publication content.');
      await client.query('COMMIT');
      return {
        provider: target.provider,
        fingerprint,
        duplicateConflicts: conflicts,
        reservationId,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async release(reservationId: string | null): Promise<void> {
    if (!reservationId) return;
    try {
      await this.pool.query('DELETE FROM publishing_reservations WHERE id = $1', [reservationId]);
    } catch {
      // A cleanup failure must not turn a successful external post into a tool
      // error. Keeping the reservation conservatively blocks duplicates.
      console.warn('[publishing-guard] reservation cleanup failed');
    }
  }

  private async getTargetAccount(socialAccountId: string): Promise<TargetAccountRow> {
    const result = await this.pool.query<TargetAccountRow>(
      `SELECT provider
         FROM social_accounts
        WHERE id = $1
          AND status = 'active'`,
      [socialAccountId],
    );
    const target = result.rows[0];

    if (!target) {
      throw new PublishingGuardError('Target social account is not active or does not exist.');
    }

    return target;
  }

  private async findDuplicateConflicts(
    client: PoolClient,
    provider: SocialProvider,
    fingerprint: string,
    start: Date,
    end: Date,
  ): Promise<DuplicateConflict[]> {
    const result = await client.query<DuplicateRow>(
      `SELECT *
         FROM (
           SELECT 'published'::text AS source,
                  pp.id AS record_id,
                  pp.social_account_id,
                  sa.account_name,
                  pp.published_at AS event_at
             FROM published_posts pp
             JOIN social_accounts sa ON sa.id = pp.social_account_id
            WHERE sa.provider = $1
              AND pp.content_fingerprint = $2
              AND pp.published_at BETWEEN $3 AND $4

           UNION ALL

           SELECT 'scheduled'::text AS source,
                  sp.id AS record_id,
                  sp.social_account_id,
                  sa.account_name,
                  sp.scheduled_at AS event_at
             FROM scheduled_posts sp
             JOIN social_accounts sa ON sa.id = sp.social_account_id
            WHERE sa.provider = $1
              AND sp.content_fingerprint = $2
              AND (sp.status IN ('scheduled', 'processing')
                   OR (sp.status = 'failed' AND (
                     sp.provider_post_id IS NOT NULL
                     OR sp.last_error->>'name' = 'ThreadsPublicationUncertainError'
                   )))
              AND sp.scheduled_at BETWEEN $3 AND $4

           UNION ALL

           SELECT 'reserved'::text AS source,
                  pr.id AS record_id,
                  pr.social_account_id,
                  sa.account_name,
                  pr.target_at AS event_at
             FROM publishing_reservations pr
             JOIN social_accounts sa ON sa.id = pr.social_account_id
            WHERE pr.provider = $1
              AND pr.content_fingerprint = $2
              AND pr.target_at BETWEEN $3 AND $4
         ) duplicates
        ORDER BY event_at DESC
        LIMIT 10`,
      [provider, fingerprint, start, end],
    );

    return result.rows.map((row) => ({
      source: row.source,
      recordId: row.record_id,
      socialAccountId: row.social_account_id,
      accountName: row.account_name,
      eventAt: row.event_at,
    }));
  }
}
