import type { Pool } from 'pg';

import type { SocialProvider } from '../domain/social-account.js';
import { createContentFingerprint, type FingerprintMedia } from './content-fingerprint.js';

export interface DuplicateConflict {
  source: 'published' | 'scheduled';
  recordId: string;
  socialAccountId: string;
  accountName: string;
  eventAt: Date;
}

export interface PublishingGuardResult {
  provider: SocialProvider;
  fingerprint: string;
  duplicateConflicts: DuplicateConflict[];
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
      `Substantially identical content is already published or scheduled on the same provider within ${guardWindowHours} hour(s). Use allow_duplicate only when this duplication is intentional.`,
    );
    this.name = 'DuplicateContentError';
  }
}

export class PublishingGuard {
  public constructor(
    private readonly pool: Pool,
    private readonly duplicateGuardHours: number,
  ) {}

  public async check(input: {
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

    if (input.allowDuplicate || this.duplicateGuardHours === 0) {
      return {
        provider: target.provider,
        fingerprint,
        duplicateConflicts: [],
      };
    }

    const windowMilliseconds = this.duplicateGuardHours * 60 * 60 * 1000;
    const start = new Date(input.targetAt.getTime() - windowMilliseconds);
    const end = new Date(input.targetAt.getTime() + windowMilliseconds);
    const conflicts = await this.findDuplicateConflicts(
      target.provider,
      fingerprint,
      start,
      end,
    );

    if (conflicts.length > 0) {
      throw new DuplicateContentError(conflicts, this.duplicateGuardHours);
    }

    return {
      provider: target.provider,
      fingerprint,
      duplicateConflicts: conflicts,
    };
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
    provider: SocialProvider,
    fingerprint: string,
    start: Date,
    end: Date,
  ): Promise<DuplicateConflict[]> {
    const result = await this.pool.query<DuplicateRow>(
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
              AND sp.status IN ('scheduled', 'processing')
              AND sp.scheduled_at BETWEEN $3 AND $4
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
