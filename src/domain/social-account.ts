export const SOCIAL_PROVIDERS = ['threads', 'instagram', 'facebook', 'linkedin', 'tiktok', 'x'] as const;

export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];
export type SocialAccountStatus = 'active' | 'reauth_required' | 'disabled';

export interface SocialAccount {
  id: string;
  provider: SocialProvider;
  providerAccountId: string;
  accountName: string;
  accountType: string | null;
  status: SocialAccountStatus;
}
