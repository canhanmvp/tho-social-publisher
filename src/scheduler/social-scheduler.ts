import { PgBoss } from 'pg-boss';

import { ThreadsApiError } from '../providers/threads/threads-client.js';
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

    await this.boss.work<PublishJob>(
      QUEUE_NAME,
      { localConcurrency: this.concurrency },
      async ([job]) => {
        if (!job) {
          return;
        }

        const post = await this.posts.get(job.data.scheduledPostId);

        if (!post || post.status === 'cancelled' || post.status === 'published') {
          return;
        }

        const claimed = await this.posts.markProcessing(post.id);
        if (!claimed) {
          return;
        }

        try {
          const result = await this.publishScheduled(post);
          await this.posts.markPublished(post.id, result.providerPostId);
        } catch (error) {
          const permanent = isPermanentProviderError(error);
          const finalAttempt = permanent || job.retryCount >= RETRY_LIMIT;

          await this.posts.markAttemptFailed(post.id, serializeError(error), finalAttempt);

          if (!finalAttempt) {
            throw error;
          }
        }
      },
    );
  }

  public async stop(): Promise<void> {
    await this.boss.stop();
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

  private async publishScheduled(post: ScheduledPost) {
    return this.threads.publish({
      socialAccountId: post.socialAccountId,
      ...(post.text ? { text: post.text } : {}),
      ...(post.media.length > 0
        ? {
            media: post.media.map((item) => ({
              type: item.type,
              url: item.url,
              ...(item.altText ? { altText: item.altText } : {}),
            })),
          }
        : {}),
      ...(post.contentFingerprint ? { contentFingerprint: post.contentFingerprint } : {}),
      scheduledPostId: post.id,
    });
  }
}
