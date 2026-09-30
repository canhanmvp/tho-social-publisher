import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { SocialAccountStore } from '../db/social-account-store.js';
import type { ThreadsService } from '../providers/threads/threads-service.js';
import type { SocialScheduler } from '../scheduler/social-scheduler.js';

export interface McpDependencies {
  socialAccounts: SocialAccountStore;
  threads?: ThreadsService;
  scheduler?: SocialScheduler;
}

const imageSchema = z.object({
  type: z.literal('image'),
  url: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === 'https:', 'Image URL must use HTTPS.'),
  alt_text: z.string().min(1).optional(),
});

const postContentSchema = z
  .object({
    text: z.string().min(1).optional(),
    media: z.array(imageSchema).max(1).optional(),
  })
  .refine((value) => Boolean(value.text || value.media?.length), {
    message: 'A post requires text or one image.',
  });

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

export function buildMcpServer(dependencies: McpDependencies): McpServer {
  const server = new McpServer(
    {
      name: 'tho-social-publisher',
      version: '0.1.0',
    },
    {
      instructions:
        'List connected accounts before publishing when the target account is ambiguous. Publishing is an external side effect. Never invent account IDs.',
    },
  );

  server.registerTool(
    'list_social_accounts',
    {
      description: 'List social accounts connected to this self-hosted Tho Social Publisher instance.',
    },
    async () => {
      const accounts = await dependencies.socialAccounts.list();

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
        structuredContent: {
          provider,
          authorization_url: authorizationUrl,
        },
      };
    },
  );

  server.registerTool(
    'publish_post',
    {
      description:
        'Publish text or one public HTTPS image to one connected social account. Threads is the first implemented provider.',
      inputSchema: postContentSchema.extend({
        account_id: z.string().uuid(),
      }),
      annotations: {
        title: 'Publish social post',
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account_id, text, media }) => {
      if (!dependencies.threads) {
        return toolError('Threads publishing is not configured on this server.');
      }

      try {
        const image = media?.[0];
        const result = await dependencies.threads.publish({
          socialAccountId: account_id,
          ...(text ? { text } : {}),
          ...(image
            ? {
                image: {
                  url: image.url,
                  ...(image.alt_text ? { altText: image.alt_text } : {}),
                },
              }
            : {}),
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
            quota_usage_before_publish: result.quota.usageBeforePublish,
            quota_total: result.quota.total,
            quota_duration_seconds: result.quota.durationSeconds,
          },
        };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : 'Threads publish failed.');
      }
    },
  );

  server.registerTool(
    'schedule_post',
    {
      description:
        'Persist and schedule a social post for future server-side publishing. The MCP client does not need to remain connected.',
      inputSchema: postContentSchema.extend({
        account_id: z.string().uuid(),
        scheduled_at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
          message: 'scheduled_at must be an ISO-8601 date-time.',
        }),
      }),
      annotations: {
        title: 'Schedule social post',
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account_id, text, media, scheduled_at }) => {
      if (!dependencies.scheduler) {
        return toolError('Server-side scheduling is not configured.');
      }

      try {
        const scheduled = await dependencies.scheduler.schedule({
          socialAccountId: account_id,
          text: text ?? '',
          media:
            media?.map((item) => ({
              type: 'image' as const,
              url: item.url,
              ...(item.alt_text ? { altText: item.alt_text } : {}),
            })) ?? [],
          scheduledAt: new Date(scheduled_at),
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
            status: scheduled.status,
          },
        };
      } catch (error) {
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
        structuredContent: {
          scheduled_post_id,
          status: 'cancelled',
        },
      };
    },
  );

  return server;
}
