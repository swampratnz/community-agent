import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { EnvRefinement } from './env.js';

/**
 * Integrations slice (config.imageGen + config.github + config.devTeam +
 * config.findHelper): the opt-in outward-facing feature blocks.
 */
export const integrationsSlice = {
  // Image generation via the host Grok Build CLI (uses its SuperGrok
  // subscription login — no API key). OFF by default; admin/super-admin only.
  IMAGE_GEN_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Path to the `grok` binary (installed + logged in on the host).
  GROK_BIN: z.string().default('grok'),
  // Hard timeout for a single image generation (ms).
  IMAGE_GEN_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  // Max images one admin can generate per rolling calendar day (abuse cap on
  // top of the per-user in-flight guard). 0 = unlimited.
  IMAGE_GEN_DAILY_LIMIT: z.coerce.number().int().min(0).default(25),

  // --- GitHub issue filing (suggest_issue) ---------------------------------
  // Lets a SUPER ADMIN file an issue on the repo straight from chat. OFF by
  // default. GITHUB_ISSUE_TOKEN must be a FINE-GRAINED PAT scoped to
  // `Issues: write` on GITHUB_ISSUE_REPO ONLY (never the
  // CLAUDE_CODE_OAUTH_TOKEN) — see docs/SECURITY.md + docs/DEPLOYMENT.md. This
  // is the bot's only GitHub egress / write credential.
  GITHUB_ISSUE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  GITHUB_ISSUE_REPO: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'GITHUB_ISSUE_REPO must be "owner/repo"')
    .default('swampratnz/community-agent'),
  GITHUB_ISSUE_TOKEN: z.string().optional(),
  // Labels applied to every filed issue (comma-separated). Default
  // `community-feedback` so it enters the research pipeline as evidence rather
  // than a proposal that skips adversarial review (see docs/PIPELINE.md).
  GITHUB_ISSUE_LABELS: z.string().default('community-feedback'),
  // Max issues one super admin can file per rolling calendar day. 0 = unlimited.
  GITHUB_ISSUE_DAILY_LIMIT: z.coerce.number().int().min(0).default(10),

  // --- Dev-team dispatch service (super-admin dev_team_* tools) -------------
  // Lets a SUPER ADMIN drive a remote "dev-team" build service over the
  // tailnet straight from chat: dispatch an assess/deliver job, poll its
  // status, and fetch the result; a background poller DMs the requester when a
  // (~20 min) run finishes. OFF by default; super-admin only (see
  // docs/SECURITY.md + src/agent/tools.ts). DEV_TEAM_AUTH_TOKEN is the bearer
  // token the client sends on every request except GET /health — a credential,
  // so it's kept out of logs and added to runtimeSecrets().
  DEV_TEAM_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // The dev-team service base URL. Deliberately allows http:// as well as
  // https:// — this is a tailnet-INTERNAL endpoint (e.g.
  // http://ubuntudevagent:8738) reached only over the WireGuard-encrypted,
  // device-authenticated Tailscale network, which already provides transport
  // confidentiality/authentication. Do NOT add a `.startsWith('https://')`
  // guard here the way DOCS_INGEST_INDEX_URL/STATUS_CHECK_API_URL do: those
  // point at the public internet, this does not, and forcing https on a
  // tailnet service with no public CA-signed cert would just break the feature.
  DEV_TEAM_ENDPOINT_URL: z.string().url().optional(),
  DEV_TEAM_AUTH_TOKEN: z.string().optional(),
  // How often the completion-DM poller re-checks unnotified job watches. A
  // finished run's requester is DMed within roughly this interval. Kept small
  // (a fast, cheap tailnet GET), default 1 minute.
  DEV_TEAM_WATCH_POLL_MINUTES: z.coerce.number().int().positive().max(60).default(1),
  // Rolling calendar-day cap on dev_team_dispatch calls per super admin
  // (0 = unlimited). Same shape as GITHUB_ISSUE_DAILY_LIMIT: dispatch costs
  // real money and ~20 min of the shared dev-team box per call, and assess
  // deliberately has no CONFIRM gate, so an injected instruction reaching a
  // super-admin turn must not be able to fire it unboundedly.
  DEV_TEAM_DAILY_LIMIT: z.coerce.number().int().min(0).default(10),

  // Opt-in "can someone help with X" member-to-member handoff (issue #729):
  // set_helper_availability/find_helper, the active-side consumer of #634's
  // member_interests/who_is_into. Off by default — both tools are dropped
  // from allowedTools entirely (never merely refused), byte-identical to
  // today for any deployment that doesn't set this, same convention as every
  // other tool-gating flag (ToolDef.featureFlag, filtered in agent/core.ts).
  FIND_HELPER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
};

export type IntegrationsEnv = z.infer<z.ZodObject<typeof integrationsSlice>>;

export const integrationsRefinements: EnvRefinement<IntegrationsEnv>[] = [
  {
    // A bare `grok` is PATH-resolved; a writable PATH entry could shadow it with
    // a hostile binary run as the service user (see docs/SECURITY.md §8). Fail
    // fast when the feature is on rather than trusting the deploy to get it right.
    check: (e) => !e.IMAGE_GEN_ENABLED || isAbsolute(e.GROK_BIN),
    params: {
      message: 'GROK_BIN must be an absolute path when IMAGE_GEN_ENABLED=true (avoids PATH hijack)',
      path: ['GROK_BIN'],
    },
  },
  {
    // No point enabling the tool without a credential — fail fast at startup
    // rather than at the first super-admin who tries to file an issue.
    check: (e) => !e.GITHUB_ISSUE_ENABLED || Boolean(e.GITHUB_ISSUE_TOKEN),
    params: {
      message: 'GITHUB_ISSUE_TOKEN is required when GITHUB_ISSUE_ENABLED=true',
      path: ['GITHUB_ISSUE_TOKEN'],
    },
  },
  {
    // Both the endpoint and the bearer token are required to talk to the
    // service — fail fast at startup rather than at the first super-admin who
    // tries to dispatch a job.
    check: (e) => !e.DEV_TEAM_ENABLED || (Boolean(e.DEV_TEAM_ENDPOINT_URL) && Boolean(e.DEV_TEAM_AUTH_TOKEN)),
    params: {
      message: 'DEV_TEAM_ENDPOINT_URL and DEV_TEAM_AUTH_TOKEN are both required when DEV_TEAM_ENABLED=true',
      path: ['DEV_TEAM_ENABLED'],
    },
  },
];
