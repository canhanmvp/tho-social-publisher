import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { PublishedPostStore } from '../db/published-post-store.js';
import type { SocialAccountStore } from '../db/social-account-store.js';
import type { PublishingGuard } from '../guardrails/publishing-guard.js';
import { DuplicateContentError } from '../guardrails/publishing-guard.js';
import type { ThreadsService } from '../providers/threads/threads-service.js';
import type { SocialScheduler } from '../scheduler/social-scheduler.js';

export interface McpDependencies {
  socialAccounts: SocialAccountStore;
  publishedPosts: PublishedPostStore;
  publishingGuard: PublishingGuard;
  threads?: ThreadsService;
  scheduler?: SocialScheduler;
}

const providerSchema = z.enum(['threads', 'instagram', 'facebook', 'linkedin', 'tiktok', 'x']);

const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'Media URL must use HTTPS.');

const mediaSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('image'),
    url: httpsUrlSchema,
    alt_text: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('video'),
    url: httpsUrlSchema,
    alt_text: z.string().min(1).optional(),
  }),
]);

const postContentSchema = z
  .object({
    text: z.string().min(1).optional(),
    media: z.array(mediaSchema).max(20).optional(),
  })
  .refine((value) => Boolean(value.text || value.media?.length), {
    message: 'A post requires text or media.',
  });

function toolError(message: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
    ...(details ? { structuredContent: details } : {}),
  };
}

function duplicateToolError(error: DuplicateContentError) {
  return toolError(error.message, {
    error: 'duplicate_content',
    duplicate_guard_hours: error.guardWindowHours,
    conflicts: error.conflicts.map((conflict) => ({
      source: conflict.source,
      record_id: conflict.recordId,
      account_id: conflict.socialAccountId,
      account_name: conflict.accountName,
      event_at: conflict.eventAt.toISOString(),
    })),
  });
}

function toGuardMedia(
  media: Array<{ type: 'image' | 'video'; url: string }> | undefined,
) {
  return media?.map((item) => ({ type: item.type, url: item.url }));
}

function toThreadsMedia(
  media:
    | Array<{ type: 'image' | 'video'; url: string; alt_text?: string }>
    | undefined,
) {
  return media?.map((item) => ({
    type: item.type,
    url: item.url,
    ...(item.alt_text ? { altText: item.alt_text } : {}),
  }));
}

export function buildMcpServer(dependencies: McpDependencies): McpServer {
  const server = new McpServer(
    {
      name: 'tho-social-publisher',
      version: '0.1.0',
    },
    {
      instructions:
        'List connected accounts before publishing when the target account is ambiguous. Publishing is an external side effect. Never invent account IDs. Avoid blasting identical content across multiple accounts on the same provider.',
    },
  );

  server.registerTool(
    'list_social_accounts',
    {
      description:
        'List social accounts connected to this self-hosted Tho Social Publisher instance. Inactive accounts are hidden by default.',
      inputSchema: z.object({
        include_inactive: z.boolean().default(false),
      }),
    },
    async ({ include_inactive }) => {
      const accounts = await dependencies.socialAccounts.list(include_inactive);

      return {
        content: [{ type: 'text', text: JSON.stringify({ accounts }, null, 2) }],
        structuredContent: { accounts },
      };
    },
  );

  server.registerTool(
    'connect_social_account',
    {
      description:
        'Create an OAuth authorization URL for a supported social provider. The human account owner must open the URL and grant access.',
      inputSchema: z.object({
        provider: z.literal('threads'),
      }),
    },
    async ({ provider }) => {
      if (provider !== 'threads' || !dependencies.threads) {
        return toolError('Threads OAuth is not configured on this server.');
      }

      const authorizationUrl = await dependencies.threads.createAuthorizationUrl();

      return {
        content: [
          {
            type: 'text',
            text: `Open this URL to grant Threads access: ${authorizationUrl}`,
          },
        ],
        structuredContent: { provider, authorization_url: authorizationUrl },
      };
    },
  );

  server.registerTool(
    'disconnect_social_account',
    {
      description:
        'Disconnect one local social account. Pending scheduled posts are cancelled. Stored provider credentials are purged when no other active account shares them. This does not claim to revoke provider-side authorization unless an adapter explicitly supports it.',
      inputSchema: z.object({
        account_id: z.string().uuid(),
      }),
      annotations: {
        title: 'Disconnect social account',
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ account_id }) => {
      const result = await dependencies.socialAccounts.disconnect(account_id);

      if (!result) {
        return toolError('Social account was not found.');
      }

      return {
        content: [
          {
            type: 'text',
            text: `Disconnected ${result.provider} account ${result.accountName}. Cancelled ${result.cancelledScheduledPosts} pending scheduled post(s).`,
          },
        ],
        structuredContent: {
          account_id: result.accountId,
          provider: result.provider,
          account_name: result.accountName,
          cancelled_scheduled_posts: result.cancelledScheduledPosts,
          local_credential_purged: result.credentialPurged,
          provider_authorization_revoked: false,
          remaining_active_accounts_on_credential: result.remainingActiveAccountsOnCredential,
        },
      };
    },
  );

  server.registerTool(
    'publish_post',
    {
      description:
        'Publish text, a single image/video, or a 2-20 item image/video carousel to one connected account. Exact duplicate content on the same provider is blocked within the configured guard window unless allow_duplicate is explicitly true.',
      inputSchema: postContentSchema.extend({
        account_id: z.string().uuid(),
        allow_duplicate: z.boolean().default(false),
      }),
      annotations: {
        title: 'Publish social post',
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account_id, text, media, allow_duplicate }) => {
      if (!dependencies.threads) {
        return toolError('Threads publishing is not configured on this server.');
      }

      try {
        const guardMedia = toGuardMedia(media);
        const guard = await dependencies.publishingGuard.check({
          socialAccountId: account_id,
          ...(text ? { text } : {}),
          ...(guardMedia?.length ? { media: guardMedia } : {}),
          targetAt: new Date(),
          allowDuplicate: allow_duplicate,
        });

        if (guard.provider !== 'threads') {
          return toolError(`Provider ${guard.provider} is not implemented for publishing yet.`);
        }

        const threadsMedia = toThreadsMedia(media);
        const result = await dependencies.threads.publish({
          socialAccountId: account_id,
          ...(text ? { text } : {}),
          ...(threadsMedia?.length ? { media: threadsMedia } : {}),
          contentFingerprint: guard.fingerprint,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Published Threads post ${result.providerPostId}. Quota before publish: ${result.quota.usageBeforePublish}/${result.quota.total}.`,
            },
          ],
          structuredContent: {
            provider: 'threads',
            account_id: result.socialAccountId,
            provider_post_id: result.providerPostId,
            media_count: media?.length ?? 0,
            quota_usage_before_publish: result.quota.usageBeforePublish,
            quota_total: result.quota.total,
            quota_duration_seconds: result.quota.durationSeconds,
          },
        };
      } catch (error) {
        if (error instanceof DuplicateContentError) {
          return duplicateToolError(error);
        }

        return toolError(error instanceof Error ? error.message : 'Threads publish failed.');
      }
    },
  );

  server.registerTool(
    'schedule_post',
    {
      description:
        'Persist and schedule text, a single image/video, or a 2-20 item carousel for future server-side publishing. Exact duplicate content on the same provider is blocked near the target time unless allow_duplicate is explicitly true.',
      inputSchema: postContentSchema.extend({
        account_id: z.string().uuid(),
        scheduled_at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
          message: 'scheduled_at must be an ISO-8601 date-time.',
        }),
        allow_duplicate: z.boolean().default(false),
      }),
      annotations: {
        title: 'Schedule social post',
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account_id, text, media, scheduled_at, allow_duplicate }) => {
      if (!dependencies.scheduler) {
        return toolError('Server-side scheduling is not configured.');
      }

      try {
        const scheduledAt = new Date(scheduled_at);
        const guardMedia = toGuardMedia(media);
        const guard = await dependencies.publishingGuard.check({
          socialAccountId: account_id,
          ...(text ? { text } : {}),
          ...(guardMedia?.length ? { media: guardMedia } : {}),
          targetAt: scheduledAt,
          allowDuplicate: allow_duplicate,
        });

        if (guard.provider !== 'threads') {
          return toolError(`Provider ${guard.provider} is not implemented for scheduling yet.`);
        }

        const threadsMedia = toThreadsMedia(media) ?? [];
        const scheduled = await dependencies.scheduler.schedule({
          socialAccountId: account_id,
          text: text ?? '',
          media: threadsMedia,
          contentFingerprint: guard.fingerprint,
          scheduledAt,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Scheduled post ${scheduled.id} for ${scheduled.scheduledAt.toISOString()}.`,
            },
          ],
          structuredContent: {
            scheduled_post_id: scheduled.id,
            account_id: scheduled.socialAccountId,
            scheduled_at: scheduled.scheduledAt.toISOString(),
            media_count: scheduled.media.length,
            status: scheduled.status,
          },
        };
      } catch (error) {
        if (error instanceof DuplicateContentError) {
          return duplicateToolError(error);
        }

        return toolError(error instanceof Error ? error.message : 'Failed to schedule post.');
      }
    },
  );

  server.registerTool(
    'list_scheduled_posts',
    {
      description: 'List scheduled and historical scheduled-post records.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(100),
      }),
    },
    async ({ limit }) => {
      if (!dependencies.scheduler) {
        return toolError('Server-side scheduling is not configured.');
      }

      const posts = await dependencies.scheduler.list(limit);
      const output = posts.map((post) => ({
        id: post.id,
        account_id: post.socialAccountId,
        text: post.text,
        media: post.media,
        scheduled_at: post.scheduledAt.toISOString(),
        status: post.status,
        attempts: post.attempts,
        provider_post_id: post.providerPostId,
        last_error: post.lastError,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ posts: output }, null, 2) }],
        structuredContent: { posts: output },
      };
    },
  );

  server.registerTool(
    'get_post_status',
    {
      description:
        'Get the local status of a scheduled publication. This reports scheduler state, not a fresh remote-provider fetch.',
      inputSchema: z.object({
        scheduled_post_id: z.string().uuid(),
      }),
    },
    async ({ scheduled_post_id }) => {
      if (!dependencies.scheduler) {
        return toolError('Server-side scheduling is not configured.');
      }

      const post = await dependencies.scheduler.get(scheduled_post_id);

      if (!post) {
        return toolError('Scheduled post was not found.');
      }

      const output = {
        scheduled_post_id: post.id,
        account_id: post.socialAccountId,
        status: post.status,
        attempts: post.attempts,
        scheduled_at: post.scheduledAt.toISOString(),
        provider_post_id: post.providerPostId,
        last_error: post.lastError,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    'get_recent_posts',
    {
      description:
        'List posts successfully published through this server. Results come from local publication history, not a provider-wide timeline.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
        account_id: z.string().uuid().optional(),
        provider: providerSchema.optional(),
      }),
    },
    async ({ limit, account_id, provider }) => {
      const posts = await dependencies.publishedPosts.listRecent({
        limit,
        ...(account_id ? { accountId: account_id } : {}),
        ...(provider ? { provider } : {}),
      });
      const output = posts.map((post) => ({
        id: post.id,
        provider: post.provider,
        account_id: post.socialAccountId,
        account_name: post.accountName,
        provider_post_id: post.providerPostId,
        text: post.text,
        media: post.media,
        scheduled_post_id: post.scheduledPostId,
        published_at: post.publishedAt.toISOString(),
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ posts: output }, null, 2) }],
        structuredContent: { posts: output },
      };
    },
  );

  server.registerTool(
    'cancel_scheduled_post',
    {
      description: 'Cancel a scheduled post that has not started processing.',
      inputSchema: z.object({
        scheduled_post_id: z.string().uuid(),
      }),
    },
    async ({ scheduled_post_id }) => {
      if (!dependencies.scheduler) {
        return toolError('Server-side scheduling is not configured.');
      }

      const cancelled = await dependencies.scheduler.cancel(scheduled_post_id);

      if (!cancelled) {
        return toolError('Scheduled post was not found or can no longer be cancelled.');
      }

      return {
        content: [{ type: 'text', text: `Cancelled scheduled post ${scheduled_post_id}.` }],
        structuredContent: { scheduled_post_id, status: 'cancelled' },
      };
    },
  );

  return server;
}
