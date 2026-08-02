import { z } from 'zod';

/** RBAC slice (config.rbac): env-bootstrapped super admins and access modes. */
export const rbacSlice = {
  // RBAC: super admins are env-bootstrapped (never grantable via chat).
  SUPER_ADMIN_DISCORD_IDS: z.string().optional(),
  SUPER_ADMIN_WHATSAPP_NUMBERS: z.string().optional(),
  // Access mode per platform: 'gated' = only registered members get replies.
  ACCESS_MODE_DISCORD: z.enum(['gated', 'open']).default('gated'),
  ACCESS_MODE_WHATSAPP: z.enum(['gated', 'open']).default('gated'),
};
