import { assertAtLeast } from '../../auth/rbac.js';
import { buildMemberDigestContent } from '../../memberDigest.js';
import { text, untrusted } from './helpers.js';
import { defineTool } from './types.js';

export const digestMemberTools = [
  defineTool({
    name: 'community_digest',
    description:
      "On-demand pull of the community digest — the same this-week's-topics, new-in-the-knowledge-base, " +
      'project-showcase, and platform-update signals the weekly member digest post would send right now, ' +
      'without waiting for its cadence. Takes no arguments; read-only; does not affect when the next ' +
      'scheduled weekly digest post goes out. Member only.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
      // Same MEMBER_TOOLS floor re-check discipline as who_is_into/
      // share_project — publishes aggregate community-wide content, so this
      // excludes open-mode guests even though the tool is structurally
      // reachable at MEMBER_TOOLS tier.
      assertAtLeast(caller.role, 'member', 'community_digest');
      const message = await buildMemberDigestContent();
      if (message == null) return text('Nothing to report right now.');
      // This tool result re-enters the model's context (unlike the weekly
      // channel post, sent straight to Discord) — quarantine it the same way
      // admin_digest quarantines buildAdminDigestForAdmin's own return
      // (issue #499 review), since this text embeds model-cluster-summarized
      // topic labels, not a direct human DM.
      return text(untrusted('Community digest', message));
    },
  }),
];
