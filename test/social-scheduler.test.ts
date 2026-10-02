import type { Job } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThreadsApiError } from '../src/providers/threads/threads-client.js';
import { ThreadsPublicationUncertainError } from '../src/providers/threads/publication-error.js';
import type { ThreadsService } from '../src/providers/threads/threads-service.js';
import type { ScheduledPost, ScheduledPostStore } from '../src/scheduler/scheduled-post-store.js';
import { SocialScheduler } from '../src/scheduler/social-scheduler.js';

const boss = vi.hoisted(() => ({
  on: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  createQueue: vi.fn(),
  work: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  getJobById: vi.fn(),
}));
vi.mock('pg-boss', () => ({
  PgBoss: class {
    on = boss.on;
    start = boss.start;
    stop = boss.stop;
    createQueue = boss.createQueue;
    work = boss.work;
    send = boss.send;
    cancel = boss.cancel;
    getJobById = boss.getJobById;
  },
}));

type PublishJob = Job<{ scheduledPostId: string }>;
type Worker = (jobs: PublishJob[]) => Promise<void>;
let worker: Worker;
let scheduler: SocialScheduler;

function setup() {
  const post: ScheduledPost = {
    id: 'scheduled-id',
    socialAccountId: 'account-id',
    text: 'hello',
    media: [],
    contentFingerprint: 'fingerprint',
    scheduledAt: new Date(),
    status: 'scheduled',
    attempts: 0,
    pgbossJobId: 'job-id',
    providerPostId: null,
    lastError: null,
  };
  const posts = {
    get: vi.fn().mockImplementation(() => Promise.resolve({ ...post })),
    findPublishedId: vi.fn().mockResolvedValue(null),
    markProcessing: vi.fn().mockImplementation(() => {
      if (post.status !== 'scheduled') return Promise.resolve(false);
      post.status = 'processing';
      post.attempts++;
      return Promise.resolve(true);
    }),
    markPublished: vi.fn().mockImplementation((_id: string, providerId: string) => {
      post.status = 'published';
      post.providerPostId = providerId;
      return Promise.resolve();
    }),
    markAttemptFailed: vi
      .fn()
      .mockImplementation((_id: string, error: unknown, final: boolean, providerId?: string) => {
        post.status = final ? 'failed' : 'scheduled';
        post.lastError = error;
        post.providerPostId = providerId ?? post.providerPostId;
        return Promise.resolve();
      }),
    markInterrupted: vi.fn().mockImplementation(() => {
      post.status = 'failed';
      return Promise.resolve();
    }),
    markQueueFailure: vi.fn().mockImplementation(() => {
      post.status = 'failed';
      return Promise.resolve();
    }),
    listStaleUnfinished: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(post),
    attachJob: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(post),
  };
  const threads = { publish: vi.fn().mockResolvedValue({ providerPostId: 'remote-post-id' }) };
  boss.work.mockImplementation((_name: string, _options: unknown, callback: Worker) => {
    worker = callback;
  });
  scheduler = new SocialScheduler(
    'postgresql://unused/unused',
    posts as unknown as ScheduledPostStore,
    threads as unknown as ThreadsService,
    2,
  );
  const job = (retryCount = 0, signal = new AbortController().signal): PublishJob => ({
    id: 'job-id',
    name: 'social-publish',
    data: { scheduledPostId: post.id },
    retryCount,
    signal,
    expireInSeconds: 180,
    heartbeatSeconds: null,
  });
  return { post, posts, threads, job };
}

beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  await scheduler?.stop();
  vi.useRealTimers();
});

describe('scheduled publication recovery', () => {
  it('retries a failed local status write without creating another remote post', async () => {
    const { posts, threads, job, post } = setup();
    posts.markPublished.mockRejectedValueOnce(new Error('Database write failed'));
    await scheduler.start();
    await expect(worker([job()])).rejects.toThrow('Database write failed');
    expect(post.providerPostId).toBe('remote-post-id');
    await worker([job(1)]);
    expect(threads.publish).toHaveBeenCalledTimes(1);
    expect(post.status).toBe('published');
  });

  it('recovers legacy publication history before publishing again', async () => {
    const { posts, threads, job, post } = setup();
    post.status = 'processing';
    posts.findPublishedId.mockResolvedValue('recorded-post-id');
    await scheduler.start();
    await worker([job(1)]);
    expect(threads.publish).not.toHaveBeenCalled();
    expect(posts.markPublished).toHaveBeenCalledWith(post.id, 'recorded-post-id');
  });

  it('stops when a previous interrupted attempt has an unknown remote outcome', async () => {
    const { post, posts, threads, job } = setup();
    post.status = 'processing';
    await scheduler.start();
    await worker([job(1)]);
    expect(posts.markInterrupted).toHaveBeenCalledWith(post.id);
    expect(threads.publish).not.toHaveBeenCalled();
    expect(post.status).toBe('failed');
  });

  it('does not publish concurrently when a scheduled row has already been claimed', async () => {
    const { threads, job } = setup();
    let finish!: (value: { providerPostId: string }) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    threads.publish.mockImplementation(() => {
      notifyStarted();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await scheduler.start();
    const first = worker([job()]);
    await started;
    await worker([job()]);
    finish({ providerPostId: 'one-remote-post' });
    await first;
    expect(threads.publish).toHaveBeenCalledTimes(1);
  });

  it('never retries an uncertain provider publication', async () => {
    const { threads, job, post } = setup();
    threads.publish.mockRejectedValue(new ThreadsPublicationUncertainError());
    await scheduler.start();
    await worker([job()]);
    await worker([job(1)]);
    expect(threads.publish).toHaveBeenCalledTimes(1);
    expect(post.status).toBe('failed');
  });

  it('forwards worker cancellation and marks the interrupted publication failed', async () => {
    const { threads, job, post, posts } = setup();
    const controller = new AbortController();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    threads.publish.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      notifyStarted();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    await scheduler.start();
    const running = worker([job(0, controller.signal)]);
    await started;
    controller.abort();
    await running;
    expect(post.status).toBe('failed');
    expect(posts.markPublished).not.toHaveBeenCalled();
  });

  it('does not send an already aborted job to the provider', async () => {
    const { threads, job, post } = setup();
    const controller = new AbortController();
    controller.abort();
    await scheduler.start();
    await worker([job(0, controller.signal)]);
    expect(threads.publish).not.toHaveBeenCalled();
    expect(post.status).toBe('failed');
  });

  it('does not republish when all local writes fail after the remote success', async () => {
    const { threads, posts, job } = setup();
    posts.markPublished.mockRejectedValue(new Error('Database unavailable'));
    posts.markAttemptFailed.mockRejectedValueOnce(new Error('Database unavailable'));
    await scheduler.start();
    await expect(worker([job()])).rejects.toThrow('Database unavailable');
    await worker([job(1)]);
    expect(threads.publish).toHaveBeenCalledTimes(1);
    expect(posts.markInterrupted).toHaveBeenCalled();
  });

  it('bounds retries of safe, transient failures', async () => {
    const { threads, job, post } = setup();
    threads.publish.mockRejectedValue(new ThreadsApiError('Quota lookup unavailable', 503));
    await scheduler.start();
    for (let retryCount = 0; retryCount < 3; retryCount++) {
      await expect(worker([job(retryCount)])).rejects.toThrow('Quota lookup unavailable');
      expect(post.status).toBe('scheduled');
    }
    await worker([job(3)]);
    expect(post.status).toBe('failed');
    expect(threads.publish).toHaveBeenCalledTimes(4);
  });

  it('stops retries of permanent provider errors', async () => {
    const { threads, job, post } = setup();
    threads.publish.mockRejectedValue(new ThreadsApiError('Invalid content', 400));
    await scheduler.start();
    await worker([job()]);
    expect(post.status).toBe('failed');
  });

  it('reconciles an exhausted queue job after a crashed final attempt', async () => {
    const { post, posts, threads } = setup();
    post.status = 'processing';
    posts.listStaleUnfinished.mockResolvedValue([post]);
    boss.getJobById.mockResolvedValue({ state: 'failed' });
    await scheduler.start();
    expect(posts.markInterrupted).toHaveBeenCalledWith(post.id);
    expect(threads.publish).not.toHaveBeenCalled();
  });

  it('leaves active queue jobs alone during reconciliation', async () => {
    const { post, posts } = setup();
    post.status = 'processing';
    posts.listStaleUnfinished.mockResolvedValue([post]);
    boss.getJobById.mockResolvedValue({ state: 'active' });
    await scheduler.start();
    expect(posts.markInterrupted).not.toHaveBeenCalled();
  });

  it('reconciles terminal queue states periodically and stops maintenance on shutdown', async () => {
    vi.useFakeTimers();
    const { post, posts } = setup();
    await scheduler.start();
    post.status = 'processing';
    posts.listStaleUnfinished.mockResolvedValue([post]);
    boss.getJobById.mockResolvedValue({ state: 'failed' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts.markInterrupted).toHaveBeenCalledTimes(1);
    await scheduler.stop();
    const checks = posts.listStaleUnfinished.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts.listStaleUnfinished).toHaveBeenCalledTimes(checks);
  });

  it('enqueues with bounded backoff and persists the queue job ID', async () => {
    const { posts } = setup();
    boss.send.mockResolvedValue('queue-job-id');
    await scheduler.schedule({
      socialAccountId: 'account-id',
      text: 'hello',
      media: [],
      contentFingerprint: 'fingerprint',
      scheduledAt: new Date(Date.now() + 60_000),
    });
    expect(boss.send).toHaveBeenCalledWith(
      'social-publish',
      expect.any(Object),
      expect.objectContaining({
        retryLimit: 3,
        retryBackoff: true,
        retryDelay: 60,
        retryDelayMax: 900,
        expireInSeconds: 180,
      }),
    );
    expect(posts.attachJob).toHaveBeenCalledWith('scheduled-id', 'queue-job-id');
  });
});
