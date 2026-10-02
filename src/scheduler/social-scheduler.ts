import { PgBoss, type Job } from 'pg-boss';

import { ThreadsApiError } from '../providers/threads/threads-client.js';
import { ThreadsPublicationUncertainError } from '../providers/threads/publication-error.js';
import type { ThreadsService } from '../providers/threads/threads-service.js';
import type { ScheduledPost, ScheduledPostStore } from './scheduled-post-store.js';

const QUEUE_NAME = 'social-publish';
const RETRY_LIMIT = 3;

interface PublishJob {
  scheduledPostId: string;
}

function serializeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'UnknownError', message: 'Unknown publishing error' };
}

function isPermanentProviderError(error: unknown): boolean {
  return (
    error instanceof ThreadsApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export class SocialScheduler {
  private readonly boss: PgBoss;
  private reconciliationTimer: NodeJS.Timeout | undefined;
  private reconciliation: Promise<void> | undefined;

  public constructor(
    databaseUrl: string,
    private readonly posts: ScheduledPostStore,
    private readonly threads: ThreadsService,
    private readonly concurrency: number,
  ) {
    this.boss = new PgBoss(databaseUrl);
    this.boss.on('error', (error) => {
      console.error('[scheduler] pg-boss error', {
        name: error.name,
        message: error.message,
      });
    });
  }

  public async start(): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue(QUEUE_NAME);
    await this.reconcile();

    await this.boss.work<PublishJob>(
      QUEUE_NAME,
      { localConcurrency: this.concurrency },
      async ([job]) => {
        if (job) await this.processJob(job);
      },
    );

    this.reconciliationTimer = setInterval(() => {
      if (this.reconciliation) return;
      this.reconciliation = this.reconcile()
        .catch((error: unknown) => {
          console.error('[scheduler] reconciliation failed', serializeError(error));
        })
        .finally(() => {
          this.reconciliation = undefined;
        });
    }, 60_000);
    this.reconciliationTimer.unref();
  }

  public async stop(): Promise<void> {
    clearInterval(this.reconciliationTimer);
    await this.reconciliation;
    await this.boss.stop();
  }

  private async processJob(job: Job<PublishJob>): Promise<void> {
    const post = await this.posts.get(job.data.scheduledPostId);
    if (!post || post.status === 'cancelled' || post.status === 'published') return;

    const recordedId = post.providerPostId ?? (await this.posts.findPublishedId(post.id));
    if (recordedId) {
      // Retry only the local persistence step after a confirmed remote success.
      await this.posts.markPublished(post.id, recordedId);
      return;
    }
    if (post.status === 'failed') return;

    if (job.signal.aborted) {
      await this.posts.markAttemptFailed(post.id, serializeError(job.signal.reason), true);
      return;
    }
    const claimed = await this.posts.markProcessing(post.id);
    if (!claimed) {
      if (post.status === 'processing' && job.retryCount > 0) {
        // An interrupted attempt may have reached the provider before its
        // result was saved. Claiming it again would risk another publication.
        await this.posts.markInterrupted(post.id);
      }
      return;
    }

    let providerPostId: string | undefined;
    try {
      const result = await this.publishScheduled(post, job.signal);
      providerPostId = result.providerPostId;
      await this.posts.markPublished(post.id, providerPostId);
    } catch (error) {
      const finalAttempt =
        error instanceof ThreadsPublicationUncertainError ||
        job.signal.aborted ||
        isPermanentProviderError(error) ||
        job.retryCount >= RETRY_LIMIT;
      await this.posts.markAttemptFailed(
        post.id,
        serializeError(error),
        finalAttempt,
        providerPostId,
      );
      if (!finalAttempt) throw error;
    }
  }

  private async reconcile(): Promise<void> {
    for (const post of await this.posts.listStaleUnfinished()) {
      const recordedId = post.providerPostId ?? (await this.posts.findPublishedId(post.id));
      if (recordedId) {
        await this.posts.markPublished(post.id, recordedId);
        continue;
      }
      const job = post.pgbossJobId
        ? await this.boss.getJobById(QUEUE_NAME, post.pgbossJobId)
        : null;
      if (!job || ['failed', 'cancelled', 'completed'].includes(job.state)) {
        if (post.status === 'processing') {
          await this.posts.markInterrupted(post.id);
        } else {
          await this.posts.markQueueFailure(
            post.id,
            'The queue job ended without a confirmed publication.',
          );
        }
      }
    }
  }

  public async schedule(input: {
    socialAccountId: string;
    text: string;
    media: ScheduledPost['media'];
    contentFingerprint: string;
    scheduledAt: Date;
  }): Promise<ScheduledPost> {
    if (input.scheduledAt.getTime() <= Date.now()) {
      throw new Error('scheduled_at must be in the future.');
    }

    const post = await this.posts.create(input);

    try {
      const jobId = await this.boss.send(
        QUEUE_NAME,
        { scheduledPostId: post.id },
        {
          startAfter: input.scheduledAt,
          retryLimit: RETRY_LIMIT,
          retryDelay: 60,
          retryBackoff: true,
          retryDelayMax: 900,
          expireInSeconds: 180,
          group: { id: input.socialAccountId },
        },
      );

      if (!jobId) {
        throw new Error('pg-boss did not return a job ID.');
      }

      await this.posts.attachJob(post.id, jobId);
      return { ...post, pgbossJobId: jobId };
    } catch (error) {
      await this.posts.markQueueFailure(
        post.id,
        error instanceof Error ? error.message : 'Failed to enqueue scheduled post.',
      );
      throw error;
    }
  }

  public async list(limit = 100): Promise<ScheduledPost[]> {
    return this.posts.list(limit);
  }

  public async get(postId: string): Promise<ScheduledPost | null> {
    return this.posts.get(postId);
  }

  public async cancel(postId: string): Promise<boolean> {
    const cancelled = await this.posts.cancel(postId);

    if (!cancelled) {
      return false;
    }

    if (cancelled.pgbossJobId) {
      await this.boss.cancel(QUEUE_NAME, cancelled.pgbossJobId);
    }

    return true;
  }

  private async publishScheduled(post: ScheduledPost, signal: AbortSignal) {
    const image = post.media[0];

    return this.threads.publish({
      socialAccountId: post.socialAccountId,
      ...(post.text ? { text: post.text } : {}),
      ...(image
        ? {
            image: {
              url: image.url,
              ...(image.altText ? { altText: image.altText } : {}),
            },
          }
        : {}),
      ...(post.contentFingerprint ? { contentFingerprint: post.contentFingerprint } : {}),
      scheduledPostId: post.id,
      signal,
    });
  }
}
